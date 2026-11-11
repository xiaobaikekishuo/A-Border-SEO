#requires -Version 7.0
. (Join-Path $PSScriptRoot 'common.ps1')
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'stop-content-worker.ps1')) {
    & (Join-Path $PSScriptRoot 'stop-content-worker.ps1') -Root $script:SeoRoot
}
Invoke-SeoCompose stop
Write-Host '服务已停止，数据库保留。'
