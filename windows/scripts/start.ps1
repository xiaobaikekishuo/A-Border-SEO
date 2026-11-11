#requires -Version 7.0
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-SeoGoogleReady
Assert-SeoDocker
Assert-SeoImage
Invoke-SeoCompose config --quiet
$null = Initialize-SeoDatabaseVolume
# The database first: pending schema migrations of the image are applied (after a backup) before the app starts.
Invoke-SeoCompose up -d --wait --wait-timeout 240 db
Update-SeoDatabaseSchema
Invoke-SeoCompose up -d --wait --wait-timeout 240
$baseUrl = Get-SeoBaseUrl
$health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 15 -NoProxy
if ($health.status -ne 'ok') { throw '应用健康检查未通过。' }
Initialize-SeoDeploymentInfo
Invoke-SeoCompose ps
if (Test-Path -LiteralPath (Join-Path $script:SeoRoot 'private\content-worker-token.dpapi')) {
    & (Join-Path $PSScriptRoot 'start-content-worker.ps1') -Root $script:SeoRoot
}
Write-Host "健康检查通过。请访问 $baseUrl ，用自己的 Google 账号登录。"
Write-Host '选择站点后，可从侧边栏的“内容规划”管理支柱、选题和简报。'
