#requires -Version 7.3

function Stop-DesktopOperation([string]$Code, [string]$Message) {
    $error = [InvalidOperationException]::new($Message)
    $error.Data['desktopCode'] = $Code
    throw $error
}

function Invoke-DesktopDocker([string[]]$Arguments, [string]$Code = 'docker_failed', [string]$Message = 'Docker operation failed. Check Docker Desktop and the service diagnostics.') {
    $output = & docker --context $script:SeoDockerContext @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { Stop-DesktopOperation $Code $Message }
    return $output
}

function Invoke-DesktopCompose([string[]]$Arguments, [string]$Code, [string]$Message) {
    $composeArguments = $script:SeoCompose[2..($script:SeoCompose.Count - 1)] + $Arguments
    $null = Invoke-DesktopDocker $composeArguments $Code $Message
}

function Get-DesktopDocker {
    $result = @{ available = $false; linux = $false; compose = $false; reason = 'docker_missing' }
    if (-not (Get-Command docker -CommandType Application -ErrorAction SilentlyContinue)) { return $result }
    $endpoint = (& docker context inspect --format '{{.Endpoints.docker.Host}}' $script:SeoDockerContext 2>$null) -join ''
    if ($LASTEXITCODE -ne 0 -or $endpoint -notmatch '^npipe:////\./pipe/(docker_engine|dockerDesktopLinuxEngine)$') {
        $result.reason = 'local_context_required'
        return $result
    }
    $platform = (& docker --context $script:SeoDockerContext info --format '{{.OSType}}/{{.Architecture}}' 2>$null) -join ''
    if ($LASTEXITCODE -ne 0) { $result.reason = 'docker_not_running'; return $result }
    $result.available = $true
    $result.linux = $platform -match '^linux/'
    if ($platform -notin @('linux/x86_64', 'linux/amd64')) { $result.reason = 'linux_amd64_required'; return $result }
    & docker --context $script:SeoDockerContext compose version --short *> $null
    $result.compose = $LASTEXITCODE -eq 0
    $result.reason = if ($result.compose) { $null } else { 'compose_missing' }
    return $result
}

function Assert-DesktopDocker {
    $docker = Get-DesktopDocker
    if ($docker.reason) {
        Stop-DesktopOperation $docker.reason 'Start Docker Desktop with its local Linux x64 engine and Docker Compose enabled.'
    }
}

function Assert-DesktopConfig {
    if (-not (Test-Path -LiteralPath $script:SeoEnvPath -PathType Leaf)) {
        Stop-DesktopOperation 'config_missing' 'Complete first-run setup or select an existing Windows installation.'
    }
    $nextAuthUrl = Get-SeoEnvValue 'NEXTAUTH_URL'
    $authUrl = Get-SeoEnvValue 'AUTH_URL'
    $configuredUrls = @($nextAuthUrl, $authUrl | Where-Object { $_ })
    if ((Get-SeoBaseUrl) -cne 'http://localhost:3300' -or -not $configuredUrls.Count -or
        @($configuredUrls | Where-Object { $_.TrimEnd('/') -cne 'http://localhost:3300' }).Count) {
        Stop-DesktopOperation 'port_conflict' 'This installation uses a different address. Desktop mode requires localhost:3300 and a matching Google callback.'
    }
    $appSecret = Get-SeoEnvValue 'NEXTAUTH_SECRET' (Get-SeoEnvValue 'AUTH_SECRET')
    if (-not $appSecret -or $appSecret -like 'REPLACE_WITH_*') {
        Stop-DesktopOperation 'auth_secret_missing' 'Locate the original application secret before taking over this installation.'
    }
    $databasePassword = Get-SeoEnvValue 'POSTGRES_PASSWORD'
    if (-not $databasePassword -or $databasePassword -like 'REPLACE_WITH_*') {
        Stop-DesktopOperation 'database_password_missing' 'Locate the original database password in the selected installation configuration.'
    }
    if (-not (Test-DesktopManaged)) {
        try { Assert-SeoGoogleReady }
        catch { Stop-DesktopOperation 'google_config_missing' 'Configure the installation with its Google Web OAuth client before starting.' }
    }
    $null = Get-SeoDatabase
    $null = Get-SeoImageName
}

function Initialize-DesktopConfigEnvironment {
    # Compose gives the parent process precedence over --env-file interpolation.
    # Use only the selected installation's configuration for these keys.
    foreach ($name in @('ABORDER_SEO_IMAGE', 'ABORDER_DB_VOLUME', 'LOCAL_APP_PORT', 'POSTGRES_USER', 'POSTGRES_DB', 'POSTGRES_PASSWORD')) {
        Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue
    }
}

function Get-DesktopProjectContainers {
    $projectLabel = 'com.docker.compose.project'
    $ids = @(Invoke-DesktopDocker @('ps', '-aq', '--filter', "label=$projectLabel=$script:DesktopProject"))
    $rows = @{}
    $format = '{{json .State}}|{{json .Mounts}}|{{json .HostConfig.PortBindings}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{range .Config.Env}}{{if eq . "ABORDER_MANAGED=1"}}enabled{{end}}{{end}}'
    $db = Get-SeoDatabase
    foreach ($id in $ids) {
        $inspect = (Invoke-DesktopDocker @('inspect', '--type', 'container', '--format', $format, $id)) -split '\|', 8
        if ($inspect.Count -ne 8 -or $inspect[4] -notin @('db', 'app', 'worker') -or
            -not [IO.Path]::IsPathFullyQualified($inspect[5]) -or
            [IO.Path]::GetFullPath($inspect[5]).TrimEnd('\', '/') -ine $script:SeoRoot.TrimEnd('\', '/')) {
            Stop-DesktopOperation 'project_conflict' 'This Compose project belongs to another directory or contains an unexpected service. Select the correct installation and project.'
        }
        $state = $inspect[0] | ConvertFrom-Json -AsHashtable
        if ($inspect[6] -ieq 'True') {
            if ($state.Running) { Stop-DesktopOperation 'operation_in_progress' 'A database or verification command is still running for this project. Wait and retry.' }
            continue
        }
        $service = $inspect[4]
        if ($rows.ContainsKey($service)) { Stop-DesktopOperation 'project_conflict' 'This project has multiple containers for one service. Inspect the existing deployment before continuing.' }
        $mounts = @($inspect[1] | ConvertFrom-Json -AsHashtable)
        $bindings = $inspect[2] | ConvertFrom-Json -AsHashtable
        if ($service -eq 'db') {
            $dataMounts = @($mounts | Where-Object { $_.Destination -eq '/var/lib/postgresql/data' })
            if ($dataMounts.Count -ne 1 -or $dataMounts[0].Name -cne $db.Volume -or $bindings.Count -gt 0) {
                Stop-DesktopOperation 'volume_conflict' 'The database container does not match the configured data volume or has a published port.'
            }
        }
        if ($service -eq 'app') {
            $ports = @($bindings['3000/tcp'])
            if ($bindings.Count -ne 1 -or $ports.Count -ne 1 -or $ports[0].HostIp -ne '127.0.0.1' -or $ports[0].HostPort -ne '3300') {
                Stop-DesktopOperation 'port_conflict' 'The existing application container does not bind exclusively to 127.0.0.1:3300.'
            }
        }
        $health = if ($state.Health) { $state.Health.Status } else { '' }
        $status = if (-not $state.Running) { 'stopped' } elseif ($health) { $health } else { 'running' }
        $rows[$service] = @{
            id = $id; status = $status; imageId = $inspect[3]
            desktopMount = [bool]($mounts | Where-Object { $_.Destination -eq '/run/aborder-desktop' })
            managedMount = $inspect[7] -ceq 'enabled' -and [bool]($mounts | Where-Object {
                $_.Destination -ceq '/run/aborder-managed' -and $_.Type -ceq 'bind' -and $_.RW -eq $false
            })
        }
    }
    return $rows
}

function Assert-DesktopVolume([hashtable]$Rows) {
    $db = Get-SeoDatabase
    if (-not (Test-SeoVolume $db.Volume)) {
        Stop-DesktopOperation 'volume_missing' 'The configured database volume is missing. Select the original Docker context and volume.'
    }
    $users = @(Invoke-DesktopDocker @('ps', '-q', '--filter', "volume=$($db.Volume)"))
    foreach ($container in $users) {
        if (-not $Rows.db -or $Rows.db.id -ne $container) {
            Stop-DesktopOperation 'volume_conflict' 'Another running container uses the selected database volume. Stop that deployment first.'
        }
    }
}

function Find-DesktopLegacyProject {
    $configuredProject = Get-SeoEnvValue 'COMPOSE_PROJECT_NAME' $env:COMPOSE_PROJECT_NAME
    if ($configuredProject) { return $configuredProject }
    $volume = (Get-SeoDatabase).Volume
    $format = '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
    $projects = foreach ($id in @(Invoke-DesktopDocker @('ps', '-aq', '--filter', "volume=$volume", '--filter', 'label=com.docker.compose.service=db'))) {
        $labels = (Invoke-DesktopDocker @('inspect', '--type', 'container', '--format', $format, $id)) -split '\|', 2
        if ($labels.Count -eq 2 -and $labels[0] -cmatch '^[a-z0-9][a-z0-9_-]{0,63}$' -and
            [IO.Path]::IsPathFullyQualified($labels[1]) -and
            [IO.Path]::GetFullPath($labels[1]).TrimEnd('\', '/') -ieq $script:SeoRoot.TrimEnd('\', '/')) {
            $labels[0]
        }
    }
    $candidates = @($projects | Select-Object -Unique)
    if ($candidates.Count -gt 1) {
        Stop-DesktopOperation 'project_selection_required' 'More than one Compose project uses this directory and database volume. Select the intended project explicitly.'
    }
    if ($candidates.Count -eq 1) { return $candidates[0] }
    return 'aborder-seo-local'
}

function Test-DesktopPort([hashtable]$Rows) {
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    foreach ($listener in $listeners) {
        if ($listener.Port -ne 3300) { continue }
        if ($Rows.app.status -notin @('healthy', 'running', 'starting', 'unhealthy') -or $listener.Address.IPAddressToString -ne '127.0.0.1') {
            return $false
        }
    }
    return $true
}

function Get-DesktopContentProcess {
    $statePath = Join-Path $script:SeoRoot 'private\content-worker\worker.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
    try { $state = [IO.File]::ReadAllText($statePath) | ConvertFrom-Json }
    catch { return $null }
    if ($state.instanceId -cnotmatch '^[a-f0-9]{32}$' -or [string]$state.pid -notmatch '^[0-9]+$') { return $null }
    $scripts = @(
        (Join-Path $PSScriptRoot 'content-worker.ps1')
        (Join-Path $script:SeoRoot 'scripts\content-worker.ps1')
    )
    foreach ($path in $scripts) {
        if (Test-ContentProcessRecord $state 'worker' $path $state.instanceId) { return $state }
    }
    return $null
}

function Stop-DesktopContentProcess {
    $state = Get-DesktopContentProcess
    if (-not $state) { return }
    $signal = if ($state.scriptPath -ieq (Join-Path $PSScriptRoot 'content-worker.ps1')) { 'drain' } else { 'stop' }
    $signalPath = Join-Path $script:SeoRoot "private\content-worker\$signal-$($state.instanceId)"
    Write-SeoPrivateText $signalPath $signal
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (Test-ContentProcessRecord $state 'worker' $state.scriptPath $state.instanceId) {
        if ($timer.Elapsed.TotalSeconds -ge 25) { Stop-DesktopOperation 'content_worker_busy' 'The local content worker has not stopped. Wait for it to finish and retry.' }
        Start-Sleep -Milliseconds 250
    }
}

function Start-DesktopContentProcess {
    if (-not (Test-Path -LiteralPath (Join-Path $script:SeoRoot 'private\content-worker-token.dpapi') -PathType Leaf)) { return $null }
    if (Get-DesktopContentProcess) { return $null }
    try {
        & (Join-Path $PSScriptRoot 'start-content-worker.ps1') -Root $script:SeoRoot *> $null
        return $null
    } catch {
        return 'content_worker_start_failed'
    }
}

function Read-DesktopUpgrade {
    if (-not (Test-Path -LiteralPath $script:DesktopJournal -PathType Leaf)) { return $null }
    try { $state = [IO.File]::ReadAllText($script:DesktopJournal) | ConvertFrom-Json -AsHashtable }
    catch { Stop-DesktopOperation 'upgrade_journal_invalid' 'The upgrade record cannot be read. Use the recovery instructions before starting the services.' }
    if ($state.phase -notin @('draining', 'stopped', 'backed_up', 'migrating', 'migrated', 'verified', 'complete') -or
        $state.image -cnotmatch $script:DesktopImagePattern -or $state.version -cnotmatch '^\d+\.\d+\.\d+$' -or
        $state.context -cne $script:SeoDockerContext -or $state.project -cne $script:DesktopProject -or $state.volume -cne (Get-SeoDatabase).Volume) {
        Stop-DesktopOperation 'upgrade_journal_invalid' 'The upgrade record does not match the selected deployment. Use the recovery instructions before starting the services.'
    }
    return $state
}

function Get-DesktopStatus {
    $configured = Test-Path -LiteralPath $script:SeoEnvPath -PathType Leaf
    $docker = Get-DesktopDocker
    $rows = @{}
    $issue = $null
    $image = $null
    $baseUrl = 'http://localhost:3300'
    $volume = try { (Get-SeoDatabase).Volume } catch { $issue = 'config_invalid'; $null }
    $volumeExists = $null
    $upgrade = $null
    if ($configured) {
        try {
            Assert-DesktopConfig
            $image = Get-SeoImageName
            $upgrade = Read-DesktopUpgrade
        } catch { $issue = if ($_.Exception.Data['desktopCode']) { $_.Exception.Data['desktopCode'] } else { 'config_invalid' } }
    }
    if (-not $docker.reason) {
        if ($volume) { $volumeExists = Test-SeoVolume $volume }
        try { $rows = Get-DesktopProjectContainers }
        catch { $issue = $_.Exception.Data['desktopCode'] ?? 'project_inspection_failed' }
        if (-not $issue -and -not (Test-DesktopPort $rows)) { $issue = 'port_conflict' }
    }
    $unseen = if ($docker.reason) { 'unavailable' } else { 'missing' }
    $health = if (-not $issue -and $rows.app.status -eq 'healthy') { Get-DesktopAppHealth } else { $null }
    $managedExpected = Test-DesktopManaged
    $managed = if ($managedExpected -and $rows.app.managedMount -and $rows.worker.managedMount -and
        $rows.worker.status -eq 'healthy' -and $health.managed.enabled) {
        $health.managed
    } elseif ($managedExpected) {
        @{ enabled = $true; allowed = $false; reason = 'enforcement_pending'; phase = 'pending'; appApplied = $false; workerApplied = $false }
    } else { $null }
    $managedReconfigure = $managedExpected -and @($rows.GetEnumerator() | Where-Object {
        $_.Key -in @('app', 'worker') -and -not $_.Value.managedMount
    }).Count -gt 0
    $contentConfigured = Test-Path -LiteralPath (Join-Path $script:SeoRoot 'private\content-worker-token.dpapi') -PathType Leaf
    $contentStatus = if (Get-DesktopContentProcess) { 'running' } elseif ($contentConfigured) { 'stopped' } else { 'missing' }
    $codexAvailable = try { [bool](Resolve-ContentCodexExecutable) } catch { $false }
    return @{
        dataRoot = $script:SeoRoot; configured = $configured; baseUrl = $baseUrl
        context = $script:SeoDockerContext; project = $script:DesktopProject
        image = $image; volume = $volume; volumeExists = $volumeExists; issue = $issue
        backendVersion = $health.version; desktopMode = $health.desktopMode -eq $true
        managed = $managed; managedReconfigure = $managedReconfigure
        docker = $docker; codex = @{ available = $codexAvailable; configured = $contentConfigured }
        services = @{
            db = $rows.db.status ?? $unseen; app = $rows.app.status ?? $unseen
            worker = $rows.worker.status ?? $unseen; contentWorker = $contentStatus
        }
        upgrade = $upgrade
    }
}
