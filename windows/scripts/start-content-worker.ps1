#requires -Version 7.0
[CmdletBinding()]
param([string]$Root = (Split-Path -Parent $PSScriptRoot), [string]$CodexExe = '')
. (Join-Path $PSScriptRoot 'content-worker-common.ps1')
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $Root 'private\content-worker-token.dpapi') -PathType Leaf)) { throw '内容 Worker 还没有设置：请先运行 设置内容Worker.cmd。' }
# Preserve automatic discovery in the child instead of passing a resolved
# version path that becomes stale after the next desktop update.
if (-not [string]::IsNullOrWhiteSpace($CodexExe)) { $CodexExe = Resolve-ContentCodexExecutable $CodexExe }
$runtime = Initialize-ContentRuntime $Root
$statePath = Join-Path $runtime 'worker.json'
$workerScript = Join-Path $PSScriptRoot 'content-worker.ps1'
if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if (Test-ContentProcessRecord $state 'worker' $workerScript) { Write-Host 'Content worker is already running.'; return }
}
$instance = [Guid]::NewGuid().ToString('N')
$pwsh = (Get-Process -Id $PID).Path
# Paths are passed to PowerShell -File, never evaluated as command text.
foreach ($value in @($workerScript, $Root, $CodexExe)) { if ($value.Contains('"')) { throw 'invalid_path' } }
$arguments = @('-NoLogo', '-NoProfile', '-File', ('"' + $workerScript + '"'), '-Watch', '-Root', ('"' + $Root + '"'), '-InstanceId', $instance)
if (-not [string]::IsNullOrWhiteSpace($CodexExe)) { $arguments += @('-CodexExe', ('"' + $CodexExe + '"')) }
$process = Start-Process -FilePath $pwsh -ArgumentList $arguments -WindowStyle Hidden -PassThru
$startupTimer = [Diagnostics.Stopwatch]::StartNew()
while ($startupTimer.Elapsed.TotalSeconds -lt 45) {
    if ($process.HasExited) { throw 'Content worker startup failed. See private\content-worker\worker.log for a safe error code.' }
    if (Test-Path -LiteralPath $statePath) {
        try {
            $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            if (Test-ContentProcessRecord $state 'worker' $workerScript $instance) { Write-Host 'Content worker started in ChatGPT account mode.'; return }
        } catch { }
    }
    Start-Sleep -Milliseconds 250
}
# This exact Process object belongs to the helper invocation, so it is safe to stop.
if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
throw 'Content worker startup timed out.'
