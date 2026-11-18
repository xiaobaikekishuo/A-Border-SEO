#requires -Version 7.3

function Test-DesktopManaged {
    return $script:DesktopManagedRequired -or
        (Test-Path -LiteralPath $script:DesktopManagedDirectory -PathType Container)
}

function Assert-DesktopManagedImage([string]$Reference) {
    if (-not (Test-DesktopManaged)) { return }
    $support = (Invoke-DesktopDocker @('image', 'inspect', '--format', '{{index .Config.Labels "com.aborder-seo.managed-policy"}}', $Reference) 'image_not_downloaded' 'Download the backend image before enabling device management.') -join ''
    if ($support -cne '1') {
        Stop-DesktopOperation 'managed_image_required' 'This backend image cannot enforce device management. Apply the managed backend release before starting it.'
    }
}

function Enable-DesktopCompose {
    if ($script:SeoCompose -contains $script:DesktopOverlay) { return }
    New-Item -ItemType Directory -Path $script:DesktopMaintenanceDirectory -Force | Out-Null
    Set-SeoPrivateAcl $script:DesktopMaintenanceDirectory
    $env:ABORDER_DESKTOP_MAINTENANCE_DIR = $script:DesktopMaintenanceDirectory
    $script:SeoCompose += @('-f', $script:DesktopOverlay)
    if (Test-DesktopManaged) {
        New-Item -ItemType Directory -Path $script:DesktopManagedDirectory -Force | Out-Null
        Set-SeoPrivateAcl $script:DesktopManagedDirectory
        $env:ABORDER_DESKTOP_MANAGED_DIR = $script:DesktopManagedDirectory
        $script:SeoCompose += @('-f', $script:DesktopManagedOverlay)
    }
}

function Get-DesktopAppHealth {
    try {
        return Invoke-RestMethod -Uri 'http://127.0.0.1:3300/api/health' -TimeoutSec 5 -NoProxy -MaximumRedirection 0
    } catch { return $null }
}

function Assert-DesktopHealthy([string]$ExpectedImage = '', [string]$ExpectedVersion = '', [string]$ExpectedImageId = '') {
    $rows = Get-DesktopProjectContainers
    if ($rows.db.status -ne 'healthy' -or $rows.app.status -ne 'healthy' -or $rows.worker.status -ne 'healthy') {
        Stop-DesktopOperation 'health_failed' 'One or more backend services did not become healthy.'
    }
    $health = Get-DesktopAppHealth
    if ($health.status -cne 'ok' -or ($ExpectedVersion -and $health.version -cne $ExpectedVersion) -or
        (($ExpectedImageId -or $ExpectedImage -cmatch $script:DesktopImagePattern) -and $health.desktopMode -ne $true)) {
        Stop-DesktopOperation 'health_failed' 'The loopback health check did not confirm the expected backend version.'
    }
    if ((Test-DesktopManaged) -and (-not $rows.app.managedMount -or -not $rows.worker.managedMount -or -not $health.managed.enabled)) {
        Stop-DesktopOperation 'managed_enforcement_missing' 'The managed policy guard did not start in both backend services.'
    }
    if ($ExpectedImage -or $ExpectedImageId) {
        $imageId = if ($ExpectedImageId) { $ExpectedImageId } else {
            (Invoke-DesktopDocker @('image', 'inspect', '--format', '{{.Id}}', $ExpectedImage)) -join ''
        }
        if (-not $imageId -or $rows.app.imageId -cne $imageId -or $rows.worker.imageId -cne $imageId) {
            Stop-DesktopOperation 'version_mismatch' 'The app and worker do not both use the expected release image.'
        }
    }
}

function Assert-DesktopReleaseImage([string]$Reference) {
    if ($Reference -cnotmatch $script:DesktopImagePattern) {
        Stop-DesktopOperation 'invalid_release_image' 'The release image must reference the official GHCR repository by digest.'
    }
}

function Assert-DesktopLocalPin([string]$Reference, [string]$ImageId, [string]$Version) {
    if ($Version -cnotmatch '^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$' -or
        $Reference -cne ($script:DesktopLocalImagePrefix + $Version) -or
        $ImageId -cnotmatch '^sha256:[a-f0-9]{64}$') {
        Stop-DesktopOperation 'invalid_internal_image_pin' 'The internal build must specify an exact local image ID and matching version tag.'
    }
}

function Assert-DesktopLocalImage([string]$Reference, [string]$ImageId, [string]$Version) {
    Assert-DesktopLocalPin $Reference $ImageId $Version
    $format = '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.version"}}|{{.Os}}|{{.Architecture}}'
    $actual = (Invoke-DesktopDocker @('image', 'inspect', '--format', $format, $Reference) 'internal_image_missing' 'Load the local Docker image supplied for this internal build, then retry.') -join ''
    if ($actual -cne "$ImageId|$Version|linux|amd64") {
        Stop-DesktopOperation 'internal_image_mismatch' 'The local Docker image does not match the exact ID, version and platform pinned by this internal build.'
    }
}

function Get-DesktopLocalImagePin([string]$Reference) {
    try { $pin = [IO.File]::ReadAllText($script:DesktopLocalPinPath) | ConvertFrom-Json -AsHashtable }
    catch { Stop-DesktopOperation 'invalid_internal_image_pin' 'The internal image pin for this deployment is unavailable. Use the original internal build or upgrade to an official release.' }
    if ($pin.reference -cne $Reference) {
        Stop-DesktopOperation 'internal_image_mismatch' 'The configured image does not match the internal image pin for this deployment.'
    }
    Assert-DesktopLocalPin $pin.reference $pin.imageId $pin.version
    return $pin
}

function Get-DesktopBackup {
    $result = & (Join-Path $PSScriptRoot 'backup.ps1') -DataRoot $script:SeoRoot -DockerContext $script:SeoDockerContext -Project $script:DesktopProject 2>$null 6>$null
    $path = @($result)[-1]
    if (-not $path -or -not (Test-Path -LiteralPath (Join-Path $path 'manifest.json') -PathType Leaf)) {
        Stop-DesktopOperation 'backup_failed' 'The database backup did not finish. Check Docker, available disk space and the data directory.'
    }
    return $path
}

function Assert-DesktopBackup([string]$Path) {
    $parent = (Join-Path $script:SeoRoot 'backups') + [IO.Path]::DirectorySeparatorChar
    if (-not $Path -or -not [IO.Path]::IsPathFullyQualified($Path) -or
        -not [IO.Path]::GetFullPath($Path).StartsWith($parent, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-DesktopOperation 'backup_invalid' 'The upgrade backup location does not match this installation.'
    }
    $dump = Join-Path $Path 'database.dump'
    $manifest = [IO.File]::ReadAllText((Join-Path $Path 'manifest.json')) | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath (Join-Path $Path 'env.dpapi') -PathType Leaf) -or
        (Get-FileHash -LiteralPath $dump -Algorithm SHA256).Hash -cne $manifest.DumpSHA256) {
        Stop-DesktopOperation 'backup_invalid' 'The database archive or configuration backup is missing or fails its integrity check.'
    }
}

function Initialize-DesktopVolume {
    $pending = Join-Path $script:DesktopPrivate 'desktop-first-run'
    if (-not (Test-Path -LiteralPath $pending -PathType Leaf)) { return }
    $db = Get-SeoDatabase
    $owner = [IO.File]::ReadAllText($pending)
    if ($owner -cnotmatch '^[a-f0-9]{32}$' -or $db.Volume -cne 'aborder-seo-local_pgdata') {
        Stop-DesktopOperation 'setup_invalid' 'The first-run data volume confirmation does not match this installation.'
    }
    if (-not (Test-SeoVolume $db.Volume)) {
        $null = Invoke-DesktopDocker @('volume', 'create', '--label', 'com.aborder-seo.role=database', '--label', "com.aborder-seo.desktop-owner=$owner", $db.Volume) 'volume_create_failed' 'Docker could not create the empty database volume.'
    }
    $existingOwner = (Invoke-DesktopDocker @('volume', 'inspect', '--format', '{{index .Labels "com.aborder-seo.desktop-owner"}}', $db.Volume)) -join ''
    if ($existingOwner -cne $owner) {
        Stop-DesktopOperation 'volume_conflict' 'This volume already belongs to an existing installation. Select that installation to preserve its data and credentials.'
    }
    [IO.File]::Delete($pending)
}

function Initialize-DesktopContentToken([string]$Token) {
    $path = Join-Path $script:DesktopPrivate 'content-worker-token.dpapi'
    $bytes = [Text.Encoding]::UTF8.GetBytes($Token)
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { [IO.File]::WriteAllBytes($path, [byte[]]::new(0)) }
        Set-SeoPrivateAcl $path
        [IO.File]::WriteAllBytes($path, $protected)
    } finally { [Array]::Clear($bytes, 0, $bytes.Length) }
}

function Initialize-DesktopMissingContentToken {
    $path = Join-Path $script:DesktopPrivate 'content-worker-token.dpapi'
    if (Test-Path -LiteralPath $path -PathType Leaf) { return }
    $token = Get-SeoEnvValue 'LOCAL_CONTENT_WORKER_TOKEN'
    if (-not $token) {
        $token = New-SeoRandomToken
        Set-SeoEnvValue 'LOCAL_CONTENT_WORKER_TOKEN' $token -AddIfMissing
    }
    if ($token -cmatch '^[A-Za-z0-9_-]{32,200}$') { Initialize-DesktopContentToken $token }
}

function Initialize-DesktopSetup([string]$Reference, [string]$LocalImageId, [string]$Version) {
    if (-not $LocalImageId) { Assert-DesktopReleaseImage $Reference }
    Assert-DesktopDocker
    if ($LocalImageId) { Assert-DesktopLocalImage $Reference $LocalImageId $Version }
    Assert-DesktopManagedImage $Reference
    if (Test-Path -LiteralPath $script:SeoEnvPath) { Stop-DesktopOperation 'already_configured' 'This data directory already has a configuration.' }
    $rows = Get-DesktopProjectContainers
    if ($rows.Count -or (Test-SeoVolume (Get-SeoDatabase).Volume)) {
        Stop-DesktopOperation 'existing_installation' 'An A-Border SEO project or database volume already exists. Select the existing Windows installation.'
    }
    if (-not (Test-DesktopPort $rows)) { Stop-DesktopOperation 'port_conflict' 'Another process is listening on port 3300.' }
    try { $inputValue = [Console]::ReadLine() | ConvertFrom-Json -AsHashtable }
    catch { Stop-DesktopOperation 'setup_input_invalid' 'The workspace setup input is invalid.' }
    $googleRequired = -not (Test-DesktopManaged)
    $googleSupplied = [bool]$inputValue.googleClientId -or [bool]$inputValue.googleClientSecret
    if ($inputValue.createVolume -isnot [bool] -or -not $inputValue.createVolume -or
        (($googleRequired -or $googleSupplied) -and (
        $inputValue.googleClientId -cnotmatch '^[A-Za-z0-9._-]{1,250}\.apps\.googleusercontent\.com$' -or
        $inputValue.googleClientSecret -cnotmatch '^[A-Za-z0-9_-]{1,250}$'))) {
        Stop-DesktopOperation 'setup_input_invalid' 'Enter a valid Google Web OAuth Client ID and Client Secret, and confirm the new empty database.'
    }
    $text = [IO.File]::ReadAllText((Join-Path $script:SeoToolRoot '.env.example'))
    $text = $text.Replace('REPLACE_WITH_RANDOM_DB_PASSWORD', (New-SeoRandomHex 24)).Replace('REPLACE_WITH_RANDOM_AUTH_SECRET', (New-SeoRandomHex 32))
    $text = $text.Replace('REPLACE_WITH_GOOGLE_CLIENT_ID', [string]$inputValue.googleClientId).Replace('REPLACE_WITH_GOOGLE_CLIENT_SECRET', [string]$inputValue.googleClientSecret)
    $text = [regex]::Replace($text, '(?m)^ABORDER_SEO_IMAGE=[^\r\n]*', "ABORDER_SEO_IMAGE=$Reference")
    $token = New-SeoRandomToken
    Initialize-DesktopContentToken $token
    $text = $text.Replace('# LOCAL_CONTENT_WORKER_TOKEN=', "LOCAL_CONTENT_WORKER_TOKEN=$token")
    if ($LocalImageId) {
        $pin = @{ reference = $Reference; imageId = $LocalImageId; version = $Version }
        Write-SeoPrivateTextAtomic $script:DesktopLocalPinPath ($pin | ConvertTo-Json -Compress)
    }
    Write-SeoPrivateTextAtomic (Join-Path $script:DesktopPrivate 'desktop-first-run') ([Guid]::NewGuid().ToString('N'))
    Write-SeoPrivateTextAtomic $script:SeoEnvPath $text
    Initialize-DesktopVolume
    return Get-DesktopStatus
}

function Start-DesktopServices([string]$RequestedImage, [string]$RequestedLocalImageId, [string]$RequestedVersion) {
    Assert-DesktopDocker
    Assert-DesktopConfig
    $upgrade = Read-DesktopUpgrade
    if ($upgrade -and $upgrade.phase -ne 'complete') {
        Stop-DesktopOperation 'upgrade_pending' 'Resume the unfinished backend upgrade before starting this installation.'
    }
    $reference = Get-SeoImageName
    $localPin = $null
    if ($reference.StartsWith($script:DesktopLocalImagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $localPin = Get-DesktopLocalImagePin $reference
        if ($RequestedLocalImageId -and ($RequestedImage -cne $localPin.reference -or
            $RequestedLocalImageId -cne $localPin.imageId -or $RequestedVersion -cne $localPin.version)) {
            Stop-DesktopOperation 'internal_image_mismatch' 'This installation is pinned to a different internal backend image. Use the matching build or upgrade to an official release.'
        }
        Assert-DesktopLocalImage $localPin.reference $localPin.imageId $localPin.version
    }
    $rows = Get-DesktopProjectContainers
    Initialize-DesktopVolume
    Assert-DesktopVolume $rows
    if (-not (Test-DesktopPort $rows)) { Stop-DesktopOperation 'port_conflict' 'Another process is listening on port 3300.' }
    $managed = Test-DesktopManaged
    $recreate = $managed -and @($rows.GetEnumerator() | Where-Object {
        $_.Key -in @('app', 'worker') -and -not $_.Value.managedMount
    }).Count -gt 0
    if ($recreate) {
        Stop-DesktopServices $true
        $rows = Get-DesktopProjectContainers
    }
    Assert-DesktopManagedImage $reference
    if (Test-Path -LiteralPath $script:DesktopMaintenanceFile -PathType Leaf) { [IO.File]::Delete($script:DesktopMaintenanceFile) }
    if ($rows.app.status -eq 'healthy' -and $rows.worker.status -eq 'healthy' -and $rows.db.status -eq 'healthy') {
        Assert-DesktopHealthy $reference $localPin.version $localPin.imageId
    } else {
        if ($localPin) {
            Enable-DesktopCompose
            $env:ABORDER_DESKTOP_LOCAL_IMAGE_ID = $localPin.imageId
            $script:SeoCompose += @('-f', $script:DesktopLocalOverlay)
        }
        elseif ($managed -or $reference -cmatch $script:DesktopImagePattern) { Enable-DesktopCompose }
        else { Assert-SeoImage }
        Invoke-DesktopCompose @('up', '-d', '--no-recreate', '--wait', '--wait-timeout', '240', 'db') 'database_start_failed' 'PostgreSQL did not become healthy.'
        $schema = Get-SeoMigrationState 2>$null
        if ($schema.Ahead.Count) { Stop-DesktopOperation 'schema_ahead' 'The database requires a newer backend image.' }
        if ($schema.Pending.Count) {
            if ($schema.HasData -or $rows.app.status -in @('healthy', 'running', 'starting', 'unhealthy') -or $rows.worker.status -in @('healthy', 'running', 'starting', 'unhealthy')) {
                Stop-DesktopOperation 'upgrade_required' 'Use the update workflow to back up and migrate this installation.'
            }
            Invoke-DesktopCompose @('run', '--rm', '--no-deps', '-T', 'app', 'node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy') 'migration_failed' 'Prisma migration failed during first-run setup.'
        }
        if ($recreate) {
            Invoke-DesktopCompose @('up', '-d', '--force-recreate', '--no-deps', '--wait', '--wait-timeout', '240', 'app', 'worker') 'health_failed' 'The managed app or worker did not become healthy.'
        } else {
            Invoke-DesktopCompose @('up', '-d', '--no-recreate', '--wait', '--wait-timeout', '240') 'health_failed' 'The app or worker did not become healthy.'
        }
        Assert-DesktopHealthy $reference $localPin.version $localPin.imageId
    }
    Initialize-SeoDeploymentInfo
    $warning = Start-DesktopContentProcess
    $status = Get-DesktopStatus
    if ($warning) { $status.warning = $warning }
    return $status
}

function Get-DesktopBusyCount([bool]$Legacy, [switch]$ContentOnly) {
    $queueFilter = if ($Legacy) { 'OR ("status"::text = ''QUEUED'' AND "runAt" <= now())' } else { '' }
    $localFilter = if ($Legacy -and (Get-DesktopContentProcess)) { 'OR "status"::text = ''QUEUED''' } else { '' }
    $regular = if ($ContentOnly) { '' } else { @"
  (SELECT count(*) FROM "Job" WHERE "status"::text = 'RUNNING' $queueFilter) +
  (SELECT count(*) FROM "Crawl" WHERE "status"::text = 'RUNNING') +
  (SELECT count(*) FROM "ManusKeywordTask" WHERE "status" = 'submitting' AND "createdAt" > now() - interval '2 minutes') +
"@ }
    $sql = @"
SELECT (
  $regular
  (SELECT count(*) FROM "ContentPlanJob" WHERE "status"::text = 'RUNNING' $localFilter) +
  (SELECT count(*) FROM "AiWorkbenchJob" WHERE "status"::text = 'RUNNING' $localFilter)
);
"@
    return [int]((Invoke-SeoPsql $sql 2>$null) -join '')
}

function Stop-DesktopServices([bool]$KeepDatabase) {
    $rows = Get-DesktopProjectContainers
    Assert-DesktopVolume $rows
    $running = @('healthy', 'running', 'starting', 'unhealthy')
    if (-not ($rows.app.status -in $running -or $rows.worker.status -in $running -or (Get-DesktopContentProcess))) {
        if (-not $KeepDatabase -and $rows.db.status -in $running) { Invoke-SeoCompose stop db *> $null }
        return
    }
    $health = Get-DesktopAppHealth
    $legacy = -not ($rows.app.desktopMount -and $rows.worker.desktopMount -and $health.desktopMode)
    New-Item -ItemType Directory -Path $script:DesktopMaintenanceDirectory -Force | Out-Null
    Set-SeoPrivateAcl $script:DesktopMaintenanceDirectory
    Write-SeoPrivateText $script:DesktopMaintenanceFile 'maintenance'
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $idlePasses = 0
        while ($idlePasses -lt 2) {
            $idlePasses = if ((Get-DesktopBusyCount $legacy) -eq 0) { $idlePasses + 1 } else { 0 }
            if ($timer.Elapsed.TotalSeconds -ge 20) {
                Stop-DesktopOperation 'jobs_running' 'Background work is still active. Let it finish, then retry.'
            }
            Start-Sleep -Seconds 1
        }
        Stop-DesktopContentProcess
        Invoke-SeoCompose stop worker app *> $null
        if ((Get-DesktopBusyCount $false) -gt 0) {
            Stop-DesktopOperation 'jobs_running' 'Task state changed during shutdown. Inspect the pending work before continuing.'
        }
        if (-not $KeepDatabase) { Invoke-SeoCompose stop db *> $null }
    } finally {
        if (-not $KeepDatabase -or $timer.Elapsed.TotalSeconds -ge 20) {
            [IO.File]::Delete($script:DesktopMaintenanceFile)
        }
    }
}

function Set-DesktopUpgradePhase([hashtable]$State, [string]$Phase) {
    $State.phase = $Phase
    $State.updatedAt = [DateTime]::UtcNow.ToString('o')
    Write-SeoPrivateTextAtomic $script:DesktopJournal ($State | ConvertTo-Json -Compress -Depth 5)
}

function Update-DesktopBackend([string]$Reference, [string]$ExpectedVersion) {
    Assert-DesktopReleaseImage $Reference
    if ($ExpectedVersion -cnotmatch '^\d+\.\d+\.\d+$') { Stop-DesktopOperation 'invalid_version' 'The release backend version is invalid.' }
    Assert-DesktopDocker
    Assert-DesktopConfig
    $rows = Get-DesktopProjectContainers
    Assert-DesktopVolume $rows
    if (-not (Test-DesktopPort $rows)) { Stop-DesktopOperation 'port_conflict' 'Another process is listening on port 3300.' }
    $imageVersion = (Invoke-DesktopDocker @('image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.version"}}', $Reference) 'image_not_downloaded' 'Download the target backend image before installing the update.') -join ''
    if ($imageVersion -cne $ExpectedVersion) { Stop-DesktopOperation 'version_mismatch' 'The downloaded backend image version does not match the release manifest.' }
    Assert-DesktopManagedImage $Reference
    $state = Read-DesktopUpgrade
    if ($state -and ($state.image -cne $Reference -or $state.version -cne $ExpectedVersion) -and $state.phase -ne 'complete') {
        Stop-DesktopOperation 'upgrade_pending' 'Finish recovery of the prior backend update before selecting a different release.'
    }
    if (-not $state -or ($state.phase -eq 'complete' -and ($state.image -cne $Reference -or $state.version -cne $ExpectedVersion))) {
        $state = @{
            image = $Reference; version = $ExpectedVersion; originalImage = (Get-SeoImageName)
            project = $script:DesktopProject; volume = (Get-SeoDatabase).Volume; context = $script:SeoDockerContext
            backupPath = $null
        }
        Set-DesktopUpgradePhase $state 'draining'
    }
    if ($state.phase -eq 'complete') {
        $status = Start-DesktopServices
        Assert-DesktopHealthy $Reference $ExpectedVersion
        return $status
    }
    if ($state.phase -eq 'draining') {
        Stop-DesktopServices $true
        Set-DesktopUpgradePhase $state 'stopped'
    }
    Enable-DesktopCompose
    Write-SeoPrivateText $script:DesktopMaintenanceFile 'maintenance'
    if ($state.phase -eq 'stopped') {
        Invoke-DesktopCompose @('up', '-d', '--no-recreate', '--wait', '--wait-timeout', '240', 'db') 'database_start_failed' 'PostgreSQL did not become healthy.'
        $state.backupPath = Get-DesktopBackup
        Set-DesktopUpgradePhase $state 'backed_up'
    }
    Assert-DesktopBackup $state.backupPath
    $env:ABORDER_SEO_IMAGE = $Reference
    try {
        if ($state.phase -in @('backed_up', 'migrating')) {
            Invoke-DesktopCompose @('up', '-d', '--no-recreate', '--wait', '--wait-timeout', '240', 'db') 'database_start_failed' 'PostgreSQL did not become healthy.'
            $schema = Get-SeoMigrationState 2>$null
            if ($schema.Ahead.Count) { Stop-DesktopOperation 'schema_ahead' 'The target release does not include all applied migrations.' }
            Set-DesktopUpgradePhase $state 'migrating'
            Invoke-DesktopCompose @('run', '--rm', '--no-deps', '-T', 'app', 'node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy') 'migration_failed' 'Prisma could not apply the target migrations. The verified pre-upgrade backup is available.'
            Set-DesktopUpgradePhase $state 'migrated'
        }
        if ($state.phase -eq 'migrated') {
            Initialize-DesktopMissingContentToken
            Invoke-DesktopCompose @('up', '-d', '--wait', '--wait-timeout', '240', 'app', 'worker') 'health_failed' 'The target app or worker did not become healthy.'
            Assert-DesktopHealthy $Reference $ExpectedVersion
            Set-DesktopUpgradePhase $state 'verified'
        } elseif ($rows.app.status -ne 'healthy' -or $rows.worker.status -ne 'healthy') {
            Invoke-DesktopCompose @('up', '-d', '--no-recreate', '--wait', '--wait-timeout', '240', 'app', 'worker') 'health_failed' 'The target app or worker did not become healthy.'
        }
        Assert-DesktopHealthy $Reference $ExpectedVersion
        Set-SeoEnvValue 'ABORDER_SEO_IMAGE' $Reference -AddIfMissing
        [IO.File]::Delete($script:DesktopMaintenanceFile)
        Set-DesktopUpgradePhase $state 'complete'
    } finally { Remove-Item -LiteralPath 'Env:\ABORDER_SEO_IMAGE' -ErrorAction SilentlyContinue }
    $warning = Start-DesktopContentProcess
    $status = Get-DesktopStatus
    if ($warning) { $status.warning = $warning }
    return $status
}
