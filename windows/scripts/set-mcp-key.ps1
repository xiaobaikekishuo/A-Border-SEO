#requires -Version 7.0
. (Join-Path $PSScriptRoot 'common.ps1')
$token=Read-SeoSecret '输入新的 MCP Key（在后台“设置 → MCP”创建访问密钥；隐藏输入，不是 OpenAI Key）'
$bytes=$null
try {
    if($token -cnotmatch $script:SeoMcpKeyPattern){throw 'MCP Key 格式不正确。'}
    $body='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"aborder-seo-key-setup","version":"1.0"}}}'
    $response=Invoke-WebRequest -Uri ((Get-SeoBaseUrl)+'/mcp') -Method Post -NoProxy -TimeoutSec 30 -SkipHttpErrorCheck -ContentType 'application/json' -Headers @{Authorization="Bearer $token";Accept='application/json, text/event-stream'} -Body $body
    if($response.StatusCode -ne 200){throw "MCP 验证失败（HTTP $($response.StatusCode)），未替换本机凭据。"}
    $bytes=[Text.Encoding]::UTF8.GetBytes($token)
    $encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $path=Join-Path (Initialize-SeoPrivateDirectory) 'mcp-token.dpapi'
    if(-not (Test-Path -LiteralPath $path)){[IO.File]::WriteAllBytes($path,[byte[]]::new(0))}
    Set-SeoPrivateAcl $path
    [IO.File]::WriteAllBytes($path,$encrypted)
    Write-Host 'MCP Key 已验证并加密保存；两个 Codex 模式将在启动时加载，不写入 config.toml。'
} finally {$token=$null;if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}
