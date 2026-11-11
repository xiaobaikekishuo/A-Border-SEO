#requires -Version 7.0
[CmdletBinding()]
param([string]$Root = (Split-Path -Parent $PSScriptRoot))
. (Join-Path $PSScriptRoot 'content-worker-common.ps1')
$runtime = Join-Path ([IO.Path]::GetFullPath($Root)) 'private\content-worker'
$statePath = Join-Path $runtime 'worker.json'
$workerScript = Join-Path $PSScriptRoot 'content-worker.ps1'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host 'Content worker is stopped.'; return }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
if (-not (Test-ContentProcessRecord $state 'worker' $workerScript)) { Write-Host 'No matching owned content worker process exists.'; return }
$stopPath = Join-Path $runtime "stop-$($state.instanceId)"
[IO.File]::WriteAllText($stopPath, 'stop', [Text.UTF8Encoding]::new($false))
Set-ContentPrivateAcl $stopPath
$stopTimer = [Diagnostics.Stopwatch]::StartNew()
while ($stopTimer.Elapsed.TotalSeconds -lt 20) {
    if (-not (Test-ContentProcessRecord $state 'worker' $workerScript)) { Write-Host 'Content worker stopped.'; return }
    Start-Sleep -Milliseconds 250
}
$childPath = Join-Path $runtime 'child.json'
$child = $null
if (Test-Path -LiteralPath $childPath) {
    $child = Get-Content -LiteralPath $childPath -Raw | ConvertFrom-Json
    if (Test-ContentProcessRecord $child 'codex' $workerScript $state.instanceId) {
        $os = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.pid)"
        if ($os.ParentProcessId -eq $state.pid) { Stop-ContentOwnedProcess $child 'codex' $workerScript $state.instanceId }
    }
}
Stop-ContentOwnedProcess $state 'worker' $workerScript $state.instanceId
if (Test-Path -LiteralPath $statePath) {
    $remaining = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($remaining.instanceId -ceq $state.instanceId -and -not (Test-ContentProcessRecord $state 'worker' $workerScript)) {
        if ($child -and $child.instanceId -ceq $state.instanceId -and $child.jobDirectory) { Remove-ContentJobDirectory $runtime $child.jobDirectory }
        foreach ($path in @($statePath, $childPath, $stopPath)) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } }
    }
}
Write-Host 'Owned content worker processes stopped.'
