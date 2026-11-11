#requires -Version 7.0
. (Join-Path $PSScriptRoot 'common.ps1')
$count = Invoke-SeoPsql 'SELECT count(*) FROM "User";'
if ([int]($count -join '').Trim() -lt 1) { throw '还没有用户完成首次登录，未关闭注册。' }
Set-SeoEnvValue 'DISABLE_REGISTRATION' 'true' -AddIfMissing
Invoke-SeoCompose up -d --force-recreate --wait --wait-timeout 240 app worker
Write-Host '注册已关闭，已有用户可以继续登录。'
