#requires -Version 7.0
. (Join-Path $PSScriptRoot 'common.ps1')
$names=@('CODEX_HOME','OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_BASE_URL','OPENAI_ORG_ID','OPENAI_PROJECT_ID')
$saved=@{}
foreach($name in $names){$saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try {
    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw '未找到 Codex。请先安装 Codex 桌面版，或用 ABORDER_CODEX_BIN 指定 codex.exe 的完整路径。' }
    foreach($name in $names){Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue}
    $env:CODEX_HOME=Join-Path $script:SeoRoot 'codex\chatgpt'
    Write-Host '登录本工具专用的 ChatGPT 账号模式（与平时使用的 Codex 分开保存，互不影响）。'
    & codex login
    if($LASTEXITCODE -ne 0){throw 'ChatGPT 登录未完成。'}
    & codex login status
    if($LASTEXITCODE -ne 0){throw 'ChatGPT 登录状态检查失败。'}
} finally {
    foreach($name in $names){
        if($null -eq $saved[$name]){Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue}
        else{[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')}
    }
}
