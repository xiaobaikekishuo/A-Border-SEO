#requires -Version 7.0
[CmdletBinding()]
param([switch]$ConfigureOnly)
. (Join-Path $PSScriptRoot 'common.ps1')
if (Initialize-SeoEnvFile) { Write-Host '已生成本机私有的 .env，并填好随机的数据库密码和应用密钥。' }
Write-Host '仅在此窗口输入 Google Web OAuth 凭据。不会显示密钥或写入命令历史。'
Write-Host "回调 URI：$(Get-SeoBaseUrl)/api/auth/callback/google"
$clientId = Read-SeoSecret 'Google Client ID（隐藏输入）'
$clientSecret = Read-SeoSecret 'Google Client Secret（隐藏输入）'
try {
    if ($clientId -notmatch '^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$') { throw 'Client ID 格式不符合 Google Web OAuth 客户端。' }
    if ($clientSecret -notmatch '^[A-Za-z0-9_-]+$') { throw 'Client Secret 包含意外字符，请重新复制。' }
    Set-SeoEnvValue 'GOOGLE_CLIENT_ID' $clientId -AddIfMissing
    Set-SeoEnvValue 'GOOGLE_CLIENT_SECRET' $clientSecret -AddIfMissing
    Write-Host 'Google 配置已保存到本机私有 .env。'
} finally { $clientId=$null; $clientSecret=$null }
if (-not $ConfigureOnly) { & (Join-Path $PSScriptRoot 'start.ps1') }
