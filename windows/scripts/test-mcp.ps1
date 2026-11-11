#requires -Version 7.0
[CmdletBinding()]
param([string]$SiteId='')
. (Join-Path $PSScriptRoot 'common.ps1')
$token=Get-SeoMcpToken
$endpoint=(Get-SeoBaseUrl)+'/mcp'
$rpcId=0
function Invoke-McpRpc([string]$Method,[hashtable]$Parameters) {
    $script:rpcId++
    $body=@{jsonrpc='2.0';id=$script:rpcId;method=$Method;params=$Parameters}|ConvertTo-Json -Depth 12 -Compress
    $response=Invoke-WebRequest -Uri $endpoint -Method Post -NoProxy -TimeoutSec 90 -ContentType 'application/json' -Headers @{Authorization="Bearer $token";Accept='application/json, text/event-stream';'MCP-Protocol-Version'='2025-03-26'} -Body $body
    $data=if($response.Content -is [byte[]]){[Text.Encoding]::UTF8.GetString($response.Content)}else{[string]$response.Content}
    if($data.TrimStart().StartsWith('{')){$rpc=$data|ConvertFrom-Json -Depth 30}
    else {
        $events=@($data -split '\r?\n'|Where-Object{$_ -match '^data: '}|ForEach-Object{ $_.Substring(6)|ConvertFrom-Json -Depth 30 })
        $rpc=$events|Where-Object id -EQ $script:rpcId|Select-Object -Last 1
    }
    if(-not $rpc -or $rpc.error -or $rpc.result.isError){throw "MCP $Method 返回错误，停止验收。"}
    return $rpc.result
}
try {
    # Deliberately invalid, non-secret token. Never substitutes fabricated site data.
    $bad=Invoke-WebRequest -Uri $endpoint -Method Post -NoProxy -TimeoutSec 15 -SkipHttpErrorCheck -ContentType 'application/json' -Headers @{Authorization='Bearer invalid-acceptance-key';Accept='application/json, text/event-stream'} -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
    if($bad.StatusCode -ne 401){throw "错误 Key 应返回 401，实际为 $($bad.StatusCode)。"}
    $init=Invoke-McpRpc 'initialize' @{protocolVersion='2025-03-26';capabilities=@{};clientInfo=@{name='aborder-seo-acceptance';version='1.0'}}
    $tools=Invoke-McpRpc 'tools/list' @{}
    if('list_sites' -notin $tools.tools.name -or 'get_site_overview' -notin $tools.tools.name){throw 'MCP 缺少预期工具。'}
    $sites=Invoke-McpRpc 'tools/call' @{name='list_sites';arguments=@{}}
    $siteText=($sites.content|Where-Object type -EQ 'text'|ForEach-Object text)-join "`n"
    Write-Host $siteText
    $overview=$null
    if(-not $SiteId){$match=[regex]::Match($siteText,'\(id: ([^)]+)\)');if($match.Success){$SiteId=$match.Groups[1].Value}}
    if($SiteId){$overview=Invoke-McpRpc 'tools/call' @{name='get_site_overview';arguments=@{siteId=$SiteId}}; $overview.content|Where-Object type -EQ 'text'|ForEach-Object{Write-Host $_.text}}
    $reports=Join-Path $script:SeoRoot 'reports'
    New-Item -ItemType Directory -Force -Path $reports|Out-Null
    $report=Join-Path $reports ('mcp-acceptance-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.json')
    [pscustomobject]@{At=(Get-Date).ToString('o');WrongKeyStatus=401;Server=$init.serverInfo;ToolNames=$tools.tools.name;ListSites=$sites;Overview=$overview;ModelCalled=$false}|ConvertTo-Json -Depth 30|Set-Content -LiteralPath $report -Encoding utf8
    Write-Host 'HTTP MCP 验收记录已保存。此脚本不调用模型；Codex 端到端测试仍需在账号模式中运行验收提示词。'
} finally {$token=$null}
