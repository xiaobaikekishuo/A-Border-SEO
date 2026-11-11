#requires -Version 7.0
[CmdletBinding()]
param(
    # Optional: the site to check, as listed in the app (for example example.com). Default: the first site list_sites returns.
    [ValidatePattern('^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$')]
    [string]$Domain = ''
)
. (Join-Path $PSScriptRoot 'common.ps1')
$names=@('CODEX_HOME','OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','CODEX_ACCESS_TOKEN','ABORDER_SEO_MCP_TOKEN','OPENAI_ORG_ID','OPENAI_PROJECT_ID','NO_PROXY')
$saved=@{};foreach($name in $names){$saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
$writer=$null
try{
    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw '未找到 Codex。请先安装 Codex 桌面版，或用 ABORDER_CODEX_BIN 指定 codex.exe 的完整路径。' }
    foreach($name in $names){Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue}
    $env:CODEX_HOME=Join-Path $script:SeoRoot 'codex\chatgpt'
    $env:NO_PROXY=(@($saved['NO_PROXY'],'localhost','127.0.0.1','::1')|Where-Object{$_})-join ','
    $login=& codex login status 2>&1
    if($LASTEXITCODE -ne 0 -or ($login -join ' ') -notmatch 'ChatGPT'){throw '专用 ChatGPT 账号未登录。请先运行 登录ChatGPT.cmd；不会切换 API。'}
    $env:ABORDER_SEO_MCP_TOKEN=Get-SeoMcpToken
    $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
    $reportDir=Join-Path $script:SeoRoot 'reports'
    New-Item -ItemType Directory -Force -Path $reportDir|Out-Null
    $trace=Join-Path $reportDir "codex-acceptance-$stamp.jsonl"
    $answer=Join-Path $reportDir "codex-acceptance-$stamp.md"
    $writer=[IO.StreamWriter]::new($trace,$false,[Text.UTF8Encoding]::new($false))
    $site=if($Domain){"为 $($Domain) 调用 get_site_overview、为同一站调用 get_traffic(days=28)"}else{'为 list_sites 返回的第一个站点调用 get_site_overview、为同一站调用 get_traffic(days=28)'}
    $prompt=@"
这是 A-Border SEO 账号模式的最小连通验收。只使用 aborder_seo MCP，依次真实调用 list_sites、$($site)。用不超过 200 个中文字报告可访问站点、点击和曝光、工具返回的实际日期范围。区分日期范围与是否每天有数据。抓取若达到上限就明确说明只是样本。不要使用 shell、网页搜索、文件读取或其他工具；不要读取凭据、修改网站、启动抓取、切换登录或计费方式。工具失败必须如实报告，不能用猜测替代。完成三项读取后立即结束。
"@
    Write-Host '开始 ChatGPT 账号模式 MCP 验收；仅本次小范围读取，不回退 API。'
    & codex --ask-for-approval on-request exec --sandbox read-only --skip-git-repo-check --ephemeral --json --color never -C $reportDir -o $answer -c 'mcp_servers.aborder_seo.enabled_tools=["list_sites","get_site_overview","get_traffic"]' -c 'web_search="disabled"' $prompt 2>&1 | ForEach-Object {
        $line=$_.ToString().Replace($env:ABORDER_SEO_MCP_TOKEN,'[REDACTED]')
        $writer.WriteLine($line)
        $writer.Flush()
    }
    $code=$LASTEXITCODE
    if($code -ne 0){throw "Codex 账号验收退出码 $code；已保存脱敏诊断，不切换 API。"}
    Write-Host "Codex 验收执行完成。请核对真实 MCP 调用事件：$trace"
    Write-Host "结果：$answer"
}finally{
    if($writer){$writer.Dispose()}
    foreach($name in $names){if($null -eq $saved[$name]){Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')}}
}
