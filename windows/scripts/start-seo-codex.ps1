#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('chatgpt', 'api')]
    [string]$Mode = 'chatgpt',
    [string]$Model = '',
    [switch]$Relogin
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $IsWindows) { throw '此脚本适用于 Windows PowerShell 7。' }
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    throw '未找到 Codex。请先安装 Codex 桌面版，或用 ABORDER_CODEX_BIN 指定 codex.exe 的完整路径。'
}

$root = $script:SeoRoot
$reports = Join-Path $root 'reports'
$codexHome = Join-Path $root "codex\$Mode"
$baseUrl = Get-SeoBaseUrl

function Read-SecretText([string]$Label) {
    $secure = Read-Host $Label -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        if ([string]::IsNullOrWhiteSpace($value)) { throw '密钥不能为空。' }
        return $value
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        $secure.Dispose()
    }
}

# 只调整本脚本及其子进程的环境；退出时还原，不永久改系统变量。
$tracked = @(
    'CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL',
    'CODEX_ACCESS_TOKEN', 'ABORDER_SEO_MCP_TOKEN', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'NO_PROXY', 'TERM'
)
$saved = @{}
foreach ($name in $tracked) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    Invoke-WebRequest -Uri "$baseUrl/api/health" -TimeoutSec 15 -NoProxy | Out-Null
    New-Item -ItemType Directory -Force -Path $reports, $codexHome | Out-Null

    # 该目录保存认证信息，限制为当前 Windows 用户和 SYSTEM。
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $userGrant = "*${sid}:(OI)(CI)F"
    & icacls $codexHome /inheritance:r /grant:r $userGrant '*S-1-5-18:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '无法限制认证目录权限，停止登录。' }

    $configPath = Join-Path $codexHome 'config.toml'
    $config = @"
forced_login_method = "$Mode"
cli_auth_credentials_store = "file"
sandbox_mode = "read-only"
approval_policy = "on-request"

[mcp_servers.aborder_seo]
url = "$baseUrl/mcp"
bearer_token_env_var = "ABORDER_SEO_MCP_TOKEN"
startup_timeout_sec = 30
tool_timeout_sec = 90
"@

    if (-not (Test-Path $configPath)) {
        [IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
    }
    else {
        $existing = (Get-Content $configPath -Raw).Replace("`r`n", "`n").Trim()
        $expected = $config.Replace("`r`n", "`n").Trim()
        if ($existing -cne $expected) {
            # The kit's own template with another local port (LOCAL_APP_PORT changed): update the address.
            # Anything else was edited by hand and is left for a manual merge.
            $template = '^' + [regex]::Escape($expected).Replace([regex]::Escape("$baseUrl/mcp"), 'http://localhost:\d{2,5}/mcp') + '$'
            if ($existing -cmatch $template) {
                [IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
                Write-Host "已把专用配置中的后台地址更新为 $baseUrl。"
            }
            else {
                throw "专用配置 $configPath 与本工具的模板不一致（可能是手动改过或来自旧版本）。请先人工合并，不自动覆盖。"
            }
        }
    }

    foreach ($name in @('OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID')) {
        Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue
    }
    $env:CODEX_HOME = $codexHome
    $env:NO_PROXY = (@($saved['NO_PROXY'],'localhost','127.0.0.1','::1') | Where-Object { $_ }) -join ','
    # Windows Terminal supports VT; automation parents may pass TERM=dumb.
    # Keep this correction scoped to the launcher and restore it in finally.
    if ([string]::IsNullOrWhiteSpace($env:TERM) -or $env:TERM -eq 'dumb') {
        $env:TERM = 'xterm-256color'
    }

    if ($Mode -eq 'api') {
        Write-Host '当前为 API 模式：本次会话可能产生多次付费请求，费用计入 API 项目，不自动使用 Codex 订阅额度。退出后下次启动仍须确认。'
        if ((Read-Host '确认继续请输入 API；其他输入取消') -cne 'API') {
            throw '已取消 API 模式，未发送模型请求。'
        }
    }
    else {
        Write-Host '当前为 ChatGPT 账号模式。用量不足时停止，不自动切换 API。'
    }

    if ($Relogin) {
        & codex logout
        if ($LASTEXITCODE -ne 0) { throw '专用目录退出登录失败，请检查认证状态。' }
    }

    $loginStatus = & codex login status 2>&1
    $needsLogin = ($LASTEXITCODE -ne 0)
    if ($needsLogin) {
        if ($Mode -eq 'chatgpt') {
            & codex login
            if ($LASTEXITCODE -ne 0) { throw 'ChatGPT 登录未完成。' }
        }
        else {
            $apiKey = Read-SecretText '输入 OpenAI API Key（不回显）'
            try {
                $apiKey | & codex login --with-api-key
                if ($LASTEXITCODE -ne 0) { throw 'API Key 登录失败。' }
            }
            finally { $apiKey = $null }
        }
    }

    $loginStatus = & codex login status 2>&1
    if ($LASTEXITCODE -ne 0) { throw '认证状态检查失败，不启动分析。' }
    Write-Host "专用 $Mode 认证状态检查通过。"

    $env:ABORDER_SEO_MCP_TOKEN = Get-SeoMcpToken
    & codex mcp list
    if ($LASTEXITCODE -ne 0) { throw '无法读取 MCP 配置。' }

    # The desktop-bundled CLI can run directly without standalone daemon package metadata.
    $launchArgs = @('--sandbox', 'read-only', '--ask-for-approval', 'on-request', '-C', $reports, '--no-daemon')
    if (-not [string]::IsNullOrWhiteSpace($Model)) {
        $launchArgs += @('--model', $Model)
    }
    & codex @launchArgs
    if ($LASTEXITCODE -ne 0) { throw 'Codex 会话异常结束，请查看已显示的错误。' }
}
finally {
    foreach ($name in $tracked) {
        if ($null -eq $saved[$name]) {
            Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue
        } else {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
        }
    }
}
