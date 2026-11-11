#requires -Version 7.0
[CmdletBinding()]
param([switch]$Rotate)
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-SeoEnvFile
$private = Initialize-SeoPrivateDirectory
$tokenPath = Join-Path $private 'content-worker-token.dpapi'
$running = @(& docker @script:SeoCompose ps --status running --services 2>$null)
$token = Get-SeoEnvValue 'LOCAL_CONTENT_WORKER_TOKEN'
$changed = $false
if ($Rotate -or $token -cnotmatch '^[A-Za-z0-9_-]{32,200}$') {
    $token = New-SeoRandomToken
    Set-SeoEnvValue 'LOCAL_CONTENT_WORKER_TOKEN' $token -AddIfMissing
    $changed = $true
}
# The app checks the token from .env; the worker reads the same token from a file only this Windows user can decrypt.
$bytes = [Text.Encoding]::UTF8.GetBytes($token)
try {
    $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if (-not (Test-Path -LiteralPath $tokenPath)) { [IO.File]::WriteAllBytes($tokenPath, [byte[]]::new(0)) }
    Set-SeoPrivateAcl $tokenPath
    [IO.File]::WriteAllBytes($tokenPath, $protected)
} finally { [Array]::Clear($bytes, 0, $bytes.Length); $token = $null }
if ($changed) {
    Write-Host '已生成内容 Worker 令牌，写入 .env 并加密保存到 private 目录。'
    if ($running -contains 'app') {
        # The app reads .env when its container starts; a worker still holding the old token is stopped first.
        & (Join-Path $PSScriptRoot 'stop-content-worker.ps1') -Root $script:SeoRoot
        Invoke-SeoCompose up -d --force-recreate --wait --wait-timeout 240 app worker
    }
} else {
    Write-Host '内容 Worker 令牌已设置（需要更换时运行：设置内容Worker.cmd -Rotate）。'
}
# The worker drafts with the dedicated ChatGPT account of this kit (codex\chatgpt), never with an API key.
$names = @('CODEX_HOME','OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_BASE_URL','OPENAI_ORG_ID','OPENAI_PROJECT_ID')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$loggedIn = $false
try {
    foreach ($name in $names) { Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue }
    $env:CODEX_HOME = Join-Path $script:SeoRoot 'codex\chatgpt'
    if (Get-Command codex -ErrorAction SilentlyContinue) {
        $status = & codex login status 2>&1
        $loggedIn = ($LASTEXITCODE -eq 0 -and ($status -join ' ') -match 'ChatGPT')
    }
} finally {
    foreach ($name in $names) {
        if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    }
}
if (-not $loggedIn) {
    Write-Host '内容 Worker 使用的专用 ChatGPT 账号还没有登录：请运行 登录ChatGPT.cmd，然后运行 启动内容Worker.cmd。'
    return
}
if ($running -contains 'app') {
    & (Join-Path $PSScriptRoot 'start-content-worker.ps1') -Root $script:SeoRoot
} else {
    Write-Host '设置完成。以后运行 启动服务.cmd 时，内容 Worker 会一起启动。'
}
