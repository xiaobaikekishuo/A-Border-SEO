#requires -Version 7.3
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$script:SeoRoot = Split-Path -Parent $PSScriptRoot
$script:SeoEnvPath = Join-Path $script:SeoRoot '.env'
# Docker Desktop's Linux engine. ABORDER_DOCKER_CONTEXT selects another context (for example "default").
$script:SeoDockerContext = if ($env:ABORDER_DOCKER_CONTEXT -match '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') { $env:ABORDER_DOCKER_CONTEXT } else { 'desktop-linux' }
$script:SeoCompose = @('--context',$script:SeoDockerContext,'compose','--project-directory',$script:SeoRoot,'--env-file',$script:SeoEnvPath,'-f',(Join-Path $script:SeoRoot 'compose.local.yml'))

function ConvertFrom-SeoEnvText([string]$Raw) {
    $value = $Raw.Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
        return $value.Substring(1, $value.Length - 2)
    }
    # Like Compose: an unquoted value ends at " #".
    $comment = $value.IndexOf(' #')
    if ($comment -ge 0) { $value = $value.Substring(0, $comment).TrimEnd() }
    return $value
}
function Read-SeoEnvFile([string]$Path) {
    # Key -> @{ Line; Value }. A repeated key keeps its first position and its last value, as Compose reads it.
    $map = [ordered]@{}
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
            $map[$Matches[1]] = [pscustomobject]@{ Line = $line; Value = (ConvertFrom-SeoEnvText $Matches[2]) }
        }
    }
    return $map
}
function Get-SeoEnvValue([string]$Name, [string]$Default = '') {
    if (-not (Test-Path -LiteralPath $script:SeoEnvPath -PathType Leaf)) { return $Default }
    $values = Read-SeoEnvFile $script:SeoEnvPath
    if ($values.Contains($Name) -and $values[$Name].Value) { return $values[$Name].Value }
    return $Default
}
function Assert-SeoEnvFile {
    if (-not (Test-Path -LiteralPath $script:SeoEnvPath -PathType Leaf)) { throw '还没有 .env 配置文件。请先运行 配置Google.cmd。' }
}
function Get-SeoBaseUrl {
    $raw = Get-SeoEnvValue 'LOCAL_APP_PORT' '3300'
    $port = 0
    if (-not [int]::TryParse($raw, [ref]$port) -or $port -lt 1024 -or $port -gt 65535) { throw '.env 中的 LOCAL_APP_PORT 应是 1024 到 65535 之间的端口号。' }
    return "http://localhost:$port"
}
function Get-SeoDatabase {
    $user = Get-SeoEnvValue 'POSTGRES_USER' 'aborder'
    $name = Get-SeoEnvValue 'POSTGRES_DB' 'aborder'
    $volume = Get-SeoEnvValue 'ABORDER_DB_VOLUME' 'aborder-seo-local_pgdata'
    if ($user -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,62}$' -or $name -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,62}$') { throw '.env 中的 POSTGRES_USER 或 POSTGRES_DB 含有意外字符。' }
    if ($volume -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$') { throw '.env 中的 ABORDER_DB_VOLUME 含有意外字符。' }
    return [pscustomobject]@{ User = $user; Name = $name; Volume = $volume }
}
function Get-SeoImageName {
    $image = Get-SeoEnvValue 'ABORDER_SEO_IMAGE' 'a-border-seo:1.1.2'
    if ($image -notmatch '^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$') { throw '.env 中的 ABORDER_SEO_IMAGE 不是有效的镜像名。' }
    return $image
}

function Add-SeoPathEntry([string]$Directory) {
    if (-not $Directory -or -not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
    $entries = @($env:PATH -split ';' | Where-Object { $_ })
    if ($entries -notcontains $Directory) { $env:PATH = (@($Directory) + $entries) -join ';' }
}
function Find-SeoCodexExecutable {
    # ABORDER_CODEX_BIN: full path to codex.exe. Otherwise the newest CLI bundled with the Codex desktop app.
    $explicit = $env:ABORDER_CODEX_BIN
    if (-not [string]::IsNullOrWhiteSpace($explicit)) {
        if ([IO.Path]::IsPathFullyQualified($explicit) -and $explicit -match '(?i)\.exe$' -and (Test-Path -LiteralPath $explicit -PathType Leaf)) { return [IO.Path]::GetFullPath($explicit) }
        throw 'ABORDER_CODEX_BIN 必须是 codex.exe 的完整路径。'
    }
    if (-not $env:LOCALAPPDATA) { return $null }
    $installRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) { return $null }
    $latest = Get-ChildItem -LiteralPath $installRoot -Directory |
        Where-Object { $_.Name -cmatch '^[a-f0-9]{16,64}$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'codex.exe') -PathType Leaf) } |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($latest) { return (Join-Path $latest.FullName 'codex.exe') }
    return $null
}
function Initialize-SeoToolPath {
    # Only this process and its children see the change; the system PATH is not modified.
    if (-not $IsWindows) { return }
    if (-not (Get-Command docker -CommandType Application -ErrorAction SilentlyContinue)) {
        $candidates = @()
        if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin' }
        if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin' }
        foreach ($dir in $candidates) {
            if (Test-Path -LiteralPath (Join-Path $dir 'docker.exe') -PathType Leaf) { Add-SeoPathEntry $dir; break }
        }
    }
    $codex = Find-SeoCodexExecutable
    if ($codex) { Add-SeoPathEntry (Split-Path -Parent $codex) }
}
Initialize-SeoToolPath

function Invoke-SeoCompose {
    & docker @script:SeoCompose @args
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed (exit $LASTEXITCODE)." }
}
function Invoke-SeoDocker {
    & docker --context $script:SeoDockerContext @args
    if ($LASTEXITCODE -ne 0) { throw "Docker failed (exit $LASTEXITCODE)." }
}
function Assert-SeoDocker {
    $version = & docker --context $script:SeoDockerContext version --format '{{.Server.Version}}' 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $version) { throw "无法连接 Docker（上下文 $($script:SeoDockerContext)）。请先启动 Docker Desktop。" }
}
function Test-SeoVolume([string]$Name) {
    & docker --context $script:SeoDockerContext volume inspect $Name *> $null
    return ($LASTEXITCODE -eq 0)
}
function Assert-SeoImage {
    $image = Get-SeoImageName
    & docker --context $script:SeoDockerContext image inspect $image *> $null
    if ($LASTEXITCODE -eq 0) { return }
    # A registry image is pulled by Compose; a local name has to be built first.
    if ($image -notmatch '/') { throw "本机还没有镜像 $image。请先运行 构建镜像.cmd。" }
}
function Invoke-SeoPsql([string]$Sql) {
    # SQL goes in on stdin, so quotes in it never depend on how arguments are passed to docker.exe.
    $db = Get-SeoDatabase
    $output = $Sql | & docker @script:SeoCompose exec -T db psql -U $db.User -d $db.Name -tA -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) { throw '数据库查询失败。' }
    return @($output | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
}

function Set-SeoPrivateAcl([string]$Path) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl = if (Test-Path -LiteralPath $Path -PathType Container) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($sid,'S-1-5-18')) {
        $principal = [Security.Principal.SecurityIdentifier]::new($identity)
        $rule = if (Test-Path -LiteralPath $Path -PathType Container) {
            [Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        } else { [Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl','Allow') }
        $acl.AddAccessRule($rule)
    }
    # Persist only the modified access rules; Set-Acl may also request SACL
    # privileges on existing files under some Windows/PowerShell versions.
    if (Test-Path -LiteralPath $Path -PathType Container) {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path),$acl)
    } else {
        [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path),$acl)
    }
}
function Initialize-SeoPrivateDirectory {
    $path = Join-Path $script:SeoRoot 'private'
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { New-Item -ItemType Directory -Path $path | Out-Null }
    Set-SeoPrivateAcl $path
    return $path
}
function Write-SeoPrivateText([string]$Path, [string]$Text) {
    # Restrict the (empty) file first, then write: the content never sits under inherited permissions.
    if (-not (Test-Path -LiteralPath $Path)) { [IO.File]::WriteAllText($Path, '') }
    Set-SeoPrivateAcl $Path
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
function New-SeoRandomHex([int]$Bytes = 32) {
    $buffer = [byte[]]::new($Bytes)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}
function New-SeoRandomToken {
    # 32 random bytes as base64url: 43 characters of [A-Za-z0-9_-].
    $buffer = [byte[]]::new(32)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+','-').Replace('/','_')
}
function Initialize-SeoEnvFile {
    # First run: .env from .env.example with a random database password and application secret.
    if (Test-Path -LiteralPath $script:SeoEnvPath) { return $false }
    $text = [IO.File]::ReadAllText((Join-Path $script:SeoRoot '.env.example'))
    $text = $text.Replace('REPLACE_WITH_RANDOM_DB_PASSWORD', (New-SeoRandomHex 24)).Replace('REPLACE_WITH_RANDOM_AUTH_SECRET', (New-SeoRandomHex 32))
    Write-SeoPrivateText $script:SeoEnvPath $text
    return $true
}

function Read-SeoSecret([string]$Label) {
    $secure = Read-Host $Label -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        if ([string]::IsNullOrWhiteSpace($value)) { throw '输入不能为空。' }
        return $value
    } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secure.Dispose() }
}
function Set-SeoEnvValue([string]$Name,[string]$Value,[switch]$AddIfMissing) {
    if ($Name -notmatch '^[A-Z][A-Z0-9_]*$' -or $Value -notmatch '^[A-Za-z0-9_.:/-]+$') { throw '配置值包含意外字符，未写入。' }
    $path = $script:SeoEnvPath
    $text = [IO.File]::ReadAllText($path)
    $pattern = '(?m)^' + [regex]::Escape($Name) + '=[^\r\n]*'
    if ([regex]::IsMatch($text,$pattern)) {
        $text = [regex]::Replace($text,$pattern,[Text.RegularExpressions.MatchEvaluator]{ param($m) "$Name=$Value" })
    } elseif ($AddIfMissing) {
        $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
        if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $text += $newline }
        $text += "$Name=$Value$newline"
    } else { throw "Missing configuration field: $Name" }
    Write-SeoPrivateText $path $text
}
function Assert-SeoGoogleReady {
    Assert-SeoEnvFile
    foreach ($name in @('GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET')) {
        $value = Get-SeoEnvValue $name
        if (-not $value -or $value -match '^REPLACE_WITH_') { throw '请先运行 配置Google.cmd，在本机输入 Google OAuth 信息。' }
    }
}
function Get-SeoMcpToken {
    $path=Join-Path $script:SeoRoot 'private\mcp-token.dpapi'
    if(-not (Test-Path -LiteralPath $path)) { return Read-SeoSecret '输入 MCP Key（隐藏输入，不是 OpenAI Key）' }
    $bytes=$null
    try {
        $bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $token=[Text.Encoding]::UTF8.GetString($bytes)
        if($token -cnotmatch $script:SeoMcpKeyPattern){throw '加密 MCP 凭据格式无效，请运行 更新MCP密钥.cmd。'}
        return $token
    } finally {if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}
}
# Access keys: a short lowercase prefix, "_", 43 base64url characters (keys made by earlier versions included).
$script:SeoMcpKeyPattern = '^[a-z][a-z0-9]{1,15}_[A-Za-z0-9_-]{43}$'

function Initialize-SeoDatabaseVolume {
    # The volume is external to Compose: created here once, after a confirmation,
    # so a renamed project or a "docker compose down -v" can never swap or delete the data.
    $db = Get-SeoDatabase
    if (Test-SeoVolume $db.Volume) { return $false }
    Write-Host "数据库卷 $($db.Volume) 还不存在。继续的话会新建一个空数据库。"
    $others = @(& docker --context $script:SeoDockerContext volume ls --format '{{.Name}}' | Where-Object { $_ -match '_pgdata$' -and $_ -ne $db.Volume })
    if ($others.Count) {
        Write-Host ('这台电脑上还有其他数据库卷：' + ($others -join '、'))
        Write-Host '如果其中有你要继续使用的数据，请先取消：运行 迁移旧数据.cmd 把它复制过来，或者在 .env 里加一行 ABORDER_DB_VOLUME=卷名 直接使用它。'
    }
    if ((Read-Host '确认新建空数据库请输入 NEW；其他输入取消') -cne 'NEW') { throw '已取消，没有创建数据库。' }
    Invoke-SeoDocker volume create --label 'com.aborder-seo.role=database' $db.Volume | Out-Null
    return $true
}
function Get-SeoMigrationState {
    $hasTable = (Invoke-SeoPsql "SELECT to_regclass('public._prisma_migrations') IS NOT NULL;") -join ''
    $applied = @()
    if ($hasTable -eq 't') {
        $unfinished = [int]((Invoke-SeoPsql 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;') -join '')
        if ($unfinished -gt 0) { throw '数据库里有一次没有完成的结构升级。数据未改动；请先运行 备份.cmd，再按说明处理，不要直接启动。' }
        $applied = Invoke-SeoPsql 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;'
    }
    $listed = & docker @script:SeoCompose run --rm --no-deps -T --entrypoint ls app prisma/migrations
    if ($LASTEXITCODE -ne 0) { throw '无法读取镜像里的数据库结构升级脚本。' }
    $available = @($listed | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^\d{14}_[A-Za-z0-9_]+$' })
    if (-not $available.Count) { throw '镜像里没有数据库结构升级脚本，镜像可能不完整。' }
    return [pscustomobject]@{ HasData = ($hasTable -eq 't'); Pending = @($available | Where-Object { $_ -notin $applied }) }
}
function Update-SeoDatabaseSchema([switch]$SkipBackup) {
    # Applies the image's pending schema migrations. An existing database is backed up first.
    $state = Get-SeoMigrationState
    if (-not $state.Pending.Count) { return }
    if ($state.HasData -and -not $SkipBackup) {
        Write-Host "数据库结构需要升级（$($state.Pending.Count) 项），先自动备份。"
        $null = & (Join-Path $PSScriptRoot 'backup.ps1')
    }
    & docker @script:SeoCompose run --rm --no-deps -T app node node_modules/prisma/build/index.js migrate deploy
    if ($LASTEXITCODE -ne 0) { throw '数据库结构升级失败，数据没有删除。请查看上面的错误，必要时用备份恢复。' }
    Write-Host "数据库结构已升级（$($state.Pending.Count) 项）。"
}
function Initialize-SeoDeploymentInfo {
    # Remembers the user's own Codex configuration so 检查本地部署.cmd can confirm this kit never changed it.
    $path = Join-Path $script:SeoRoot 'deployment-info.json'
    if (Test-Path -LiteralPath $path) { return }
    $codexConfig = Join-Path $HOME '.codex\config.toml'
    $hash = if (Test-Path -LiteralPath $codexConfig -PathType Leaf) { (Get-FileHash -LiteralPath $codexConfig -Algorithm SHA256).Hash } else { $null }
    [pscustomobject]@{ CreatedAt = (Get-Date).ToString('o'); OriginalCodexConfigSHA256 = $hash } | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding utf8
}
