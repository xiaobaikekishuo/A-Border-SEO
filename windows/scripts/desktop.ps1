#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Status','Setup','InspectLegacy','Adopt','Start','Stop','Backup','Logs','Pull','Upgrade','StartContentWorker','StopContentWorker','LoginCodex')]
    [string]$Action,
    [Parameter(Mandatory)][string]$DataRoot,
    [string]$LegacyRoot = '',
    [string]$DockerContext = '',
    [string]$Project = '',
    [string]$Image = '',
    [string]$Version = '',
    [string]$LocalImageId = '',
    [switch]$Managed
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($PSVersionTable.PSVersion -lt [version]'7.3') {
    [Console]::WriteLine('{"ok":false,"code":"powershell_version_required","error":"Install PowerShell 7.3 or newer."}')
    exit 1
}
$script:DesktopImagePattern = '^ghcr\.io/xiaobaikekishuo/a-border-seo@sha256:[a-f0-9]{64}$'
$script:DesktopLocalImagePrefix = 'aborder-seo-internal:'
$windowsRoot = Split-Path -Parent $PSScriptRoot
$script:DesktopOverlay = Join-Path $windowsRoot 'compose.desktop.yml'
$script:DesktopManagedOverlay = Join-Path $windowsRoot 'compose.desktop-managed.yml'
$script:DesktopManagedRequired = $Managed.IsPresent
$script:DesktopLocalOverlay = Join-Path $windowsRoot 'compose.desktop-internal.yml'
. (Join-Path $PSScriptRoot 'desktop-common.ps1')
. (Join-Path $PSScriptRoot 'desktop-lifecycle.ps1')
. (Join-Path $PSScriptRoot 'content-worker-common.ps1')
Set-StrictMode -Off

function Get-DesktopLogs {
    $status = Get-DesktopStatus
    $events = @()
    if (-not $status.docker.reason -and -not $status.issue -and $status.configured) {
        foreach ($name in @('app', 'db', 'worker')) {
            if ($status.services[$name] -eq 'missing') { continue }
            try { $lines = @(Invoke-SeoCompose logs --no-color --no-log-prefix --timestamps --tail 50 $name 2>&1) }
            catch { continue }
            foreach ($line in $lines) {
                if ([string]$line -notmatch '^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ') { continue }
                $time = $Matches[1]
                $code = switch -Regex ($line) {
                    'database system is ready to accept connections' { 'database_ready'; break }
                    'database system is shut down' { 'database_stopped'; break }
                    'Ready in \d+' { 'app_ready'; break }
                    '\[worker\] a-border-seo \d+\.\d+\.\d+' { 'worker_started'; break }
                    '(?i)\b(error|fatal|panic|failed)\b' { 'service_error'; break }
                }
                if ($code) { $events += @{ service = $name; time = $time; code = $code } }
            }
        }
    }
    $log = Join-Path $script:SeoRoot 'private\content-worker\worker.log'
    if (Test-Path -LiteralPath $log -PathType Leaf) {
        foreach ($line in (Get-Content -LiteralPath $log -Tail 30)) {
            try { $event = $line | ConvertFrom-Json -AsHashtable } catch { continue }
            if ($event.event -in @('worker_started','worker_failed','worker_stopped','worker_api_unavailable','worker_api_recovered','job_claimed','job_failed','job_completed','app_job_failed','app_job_completed') -and
                $event.time -cmatch '^\d{4}-\d{2}-\d{2}T[0-9:.]{8,20}Z$') {
                $detail = if ($event.code -in @('codex_executable_missing','chatgpt_login_required','chatgpt_usage_limit','worker_api_failed','worker_token_missing','worker_token_invalid','worker_already_running','generation_timeout','codex_generation_failed','worker_stopped','invalid_config')) { $event.code } else { $null }
                $events += @{ service = 'contentWorker'; time = $event.time; code = $event.event; detail = $detail }
            }
        }
    }
    return @{ events = @($events | Sort-Object { $_.time } | Select-Object -Last 100) }
}

function Invoke-DesktopCodexLogin {
    $exe = try { Resolve-ContentCodexExecutable } catch {
        Stop-DesktopOperation 'codex_executable_missing' 'Install Codex or set ABORDER_CODEX_BIN to the full path to codex.exe.'
    }
    $working = Join-Path $script:DesktopPrivate 'codex-login'
    New-Item -ItemType Directory -Path $working -Force | Out-Null
    Set-SeoPrivateAcl $working
    $homePath = Join-Path $script:SeoRoot 'codex\chatgpt'
    New-Item -ItemType Directory -Path $homePath -Force | Out-Null
    Set-SeoPrivateAcl $homePath
    $arguments = @('--no-daemon', '-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"', '-c', 'model_provider="openai"', 'login')
    $start = New-ContentCodexStartInfo $exe $script:SeoRoot $working $arguments
    try { $result = Invoke-ContentCodexProcess $start '' 180 $null $null }
    catch { Stop-DesktopOperation 'codex_login_failed' 'The dedicated Codex ChatGPT login did not complete. Check the system browser and retry.' }
    if ($result.exitCode -ne 0) { Stop-DesktopOperation 'codex_login_failed' 'The dedicated Codex ChatGPT login did not complete. Check the system browser and retry.' }
    $check = New-ContentCodexStartInfo $exe $script:SeoRoot $working ($arguments + 'status')
    $result = Invoke-ContentCodexProcess $check '' 20 $null $null
    if ($result.exitCode -ne 0 -or ($result.stdout + $result.stderr) -notmatch 'Logged in using ChatGPT') {
        Stop-DesktopOperation 'codex_login_required' 'The dedicated Codex profile is not logged in with a ChatGPT account.'
    }
    return @{ loggedIn = $true }
}

$lock = $null
$result = try {
    if (-not $IsWindows) { Stop-DesktopOperation 'windows_required' 'This controller requires Windows and PowerShell 7.3 or newer.' }
    $legacy = $Action -in @('InspectLegacy','Adopt')
    $selectedRoot = if ($legacy) { $LegacyRoot } else { $DataRoot }
    if (-not $selectedRoot -or -not [IO.Path]::IsPathFullyQualified($selectedRoot) -or $selectedRoot.StartsWith('\\') -or $selectedRoot.Contains('"')) {
        Stop-DesktopOperation 'data_path_invalid' 'Choose an absolute path on a local Windows drive.'
    }
    if ($legacy -and -not (Test-Path -LiteralPath (Join-Path $selectedRoot 'compose.local.yml') -PathType Leaf)) {
        Stop-DesktopOperation 'legacy_path_invalid' 'Choose the Windows kit directory that contains compose.local.yml and the original .env.'
    }
    $projectSpecified = [bool]$Project
    $script:DesktopProject = if ($Project) { $Project } else { 'aborder-seo-local' }
    . (Join-Path $PSScriptRoot 'common.ps1') -DataRoot $selectedRoot -DockerContext $DockerContext -Project $script:DesktopProject
    if ($legacy -and -not $projectSpecified) {
        Assert-DesktopConfig
        Assert-DesktopDocker
        $script:DesktopProject = Find-DesktopLegacyProject
        . (Join-Path $PSScriptRoot 'common.ps1') -DataRoot $selectedRoot -DockerContext $DockerContext -Project $script:DesktopProject
    }
    $script:DesktopPrivate = Join-Path $script:SeoRoot 'private'
    $script:DesktopJournal = Join-Path $script:DesktopPrivate 'desktop-upgrade.json'
    $script:DesktopLocalPinPath = Join-Path $script:DesktopPrivate 'desktop-local-image.json'
    $script:DesktopMaintenanceDirectory = Join-Path $script:DesktopPrivate 'desktop-maintenance'
    $script:DesktopMaintenanceFile = Join-Path $script:DesktopMaintenanceDirectory 'maintenance'
    $script:DesktopManagedDirectory = Join-Path $script:DesktopPrivate 'managed'
    Initialize-DesktopConfigEnvironment

    if ($Action -in @('Setup','Adopt','Start','Stop','Backup','Upgrade','StartContentWorker','StopContentWorker','LoginCodex')) {
        if ($Action -notin @('Setup','Adopt')) { Assert-DesktopConfig }
        New-Item -ItemType Directory -Path $script:DesktopPrivate -Force | Out-Null
        Set-SeoPrivateAcl $script:DesktopPrivate
        try { $lock = [IO.File]::Open((Join-Path $script:DesktopPrivate 'desktop-operation.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
        catch { Stop-DesktopOperation 'operation_in_progress' 'Another desktop service operation is in progress. Wait and retry.' }
    }

    $data = switch ($Action) {
        'Status' { Get-DesktopStatus }
        'Setup' { Initialize-DesktopSetup $Image $LocalImageId $Version }
        { $_ -in @('InspectLegacy','Adopt') } {
            Assert-DesktopConfig
            Assert-DesktopDocker
            $rows = Get-DesktopProjectContainers
            Assert-DesktopVolume $rows
            if (-not (Test-DesktopPort $rows)) { Stop-DesktopOperation 'port_conflict' 'Another process is listening on port 3300.' }
            if ($Action -eq 'Adopt') { Set-SeoPrivateAcl $script:SeoEnvPath }
            Get-DesktopStatus
        }
        'Start' { Start-DesktopServices $Image $LocalImageId $Version }
        'Stop' {
            Assert-DesktopDocker
            $state = Read-DesktopUpgrade
            if ($state -and $state.phase -ne 'complete') { Stop-DesktopOperation 'upgrade_pending' 'Finish recovery of the current update before stopping the database.' }
            Stop-DesktopServices $false
            Get-DesktopStatus
        }
        'Backup' {
            Assert-DesktopDocker
            $rows = Get-DesktopProjectContainers
            Assert-DesktopVolume $rows
            if ($rows.db.status -ne 'healthy') { Stop-DesktopOperation 'database_not_running' 'Start the database before taking a backup.' }
            @{ path = (Get-DesktopBackup) }
        }
        'Logs' { Get-DesktopLogs }
        'Pull' {
            if ($LocalImageId) {
                Assert-DesktopDocker
                Assert-DesktopLocalImage $Image $LocalImageId $Version
            } else {
                Assert-DesktopReleaseImage $Image
                Assert-DesktopDocker
                $null = Invoke-DesktopDocker @('pull', '--platform', 'linux/amd64', $Image) 'image_pull_failed' 'Could not download the release image. Check the network and anonymous access to the GitHub container package.'
            }
            @{ image = $Image }
        }
        'Upgrade' { Update-DesktopBackend $Image $Version }
        'StartContentWorker' {
            Assert-DesktopDocker
            $rows = Get-DesktopProjectContainers
            if ($rows.app.status -ne 'healthy' -or (Read-DesktopUpgrade).phase -in @('draining','stopped','backed_up','migrating','migrated','verified')) {
                Stop-DesktopOperation 'app_not_running' 'Finish startup or recovery before starting the local content worker.'
            }
            if (-not (Test-Path -LiteralPath (Join-Path $script:DesktopPrivate 'content-worker-token.dpapi') -PathType Leaf)) {
                Stop-DesktopOperation 'content_worker_unconfigured' 'Set up the local content worker for this installation first.'
            }
            if (Start-DesktopContentProcess) { Stop-DesktopOperation 'content_worker_start_failed' 'The local content worker could not start. See service diagnostics for its error code.' }
            Get-DesktopStatus
        }
        'StopContentWorker' {
            Assert-DesktopDocker
            $content = Get-DesktopContentProcess
            if ($content) {
                $rows = Get-DesktopProjectContainers
                Assert-DesktopVolume $rows
                if ($content.scriptPath -ine (Join-Path $PSScriptRoot 'content-worker.ps1') -and (Get-DesktopBusyCount $true -ContentOnly) -gt 0) {
                    Stop-DesktopOperation 'jobs_running' 'Wait for active and queued content work before stopping the legacy local worker.'
                }
                Stop-DesktopContentProcess
            }
            Get-DesktopStatus
        }
        'LoginCodex' { Invoke-DesktopCodexLogin }
    }
    @{ ok = $true; data = $data }
} catch {
    $code = $_.Exception.Data['desktopCode']
    if ($code) { @{ ok = $false; code = $code; error = $_.Exception.Message } }
    else {
        $phase = try { (Read-DesktopUpgrade).phase } catch { $null }
        $message = if ($phase) {
            "The operation failed during '$phase'. Check Diagnostics and follow the recovery instructions."
        } else { 'The service operation failed. Check Docker Desktop, the selected data directory and service diagnostics.' }
        @{ ok = $false; code = ($Action.ToLowerInvariant() + '_failed'); error = $message }
    }
} finally {
    if ($lock) { $lock.Dispose() }
}
[Console]::WriteLine(($result | ConvertTo-Json -Depth 10 -Compress))
if (-not $result.ok) { exit 1 }
