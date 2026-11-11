#requires -Version 7.0
[CmdletBinding()]
param([string]$From = '')
. (Join-Path $PSScriptRoot 'common.ps1')

# .env settings taken from the other installation: sign-in, the application secret (it decrypts the
# stored Google tokens and API keys), schedules, limits and alerts. Database, image, volume and port
# settings stay those of this installation.
$carried = @(
    'GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_PAGESPEED_KEY','GOOGLE_HTTP_PROXY','OPENAI_HTTP_PROXY','MANUS_HTTP_PROXY',
    'NEXTAUTH_SECRET','AUTH_SECRET','AUTH_TRUST_HOST','DISABLE_REGISTRATION','REGISTRATION_CLOSED_MESSAGE',
    'CRAWL_MAX_PAGES','CRAWL_MAX_MINUTES','CRAWL_DETAIL_RETENTION','CRAWLER_USER_AGENT',
    'WORKER_LONG_CONCURRENCY','WORKER_SHORT_CONCURRENCY','WORKER_POLL_SECONDS','WORKER_SHUTDOWN_GRACE_SECONDS','JOB_STALE_SECONDS','JOB_RETENTION_DAYS',
    'API_RATE_LIMIT_PER_MINUTE','SCHEDULER_ENABLED','SCHEDULE_GSC_SYNC_HOURS','SCHEDULE_BING_SYNC_HOURS','SCHEDULE_CRAWL_DAYS','SCHEDULE_VITALS_DAYS','SCHEDULE_GEO_TRACKING',
    'ALERT_WEBHOOKS_ENABLED','ALERT_WEBHOOK_ALLOW_PRIVATE','ALERT_EMAILS_ENABLED','SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASSWORD','SMTP_FROM',
    'LOCAL_CONTENT_WORKER_TOKEN','UPDATE_CHECK','UPDATE_CHECK_REPO','TZ'
)

if (-not $From) {
    Write-Host '把另一个安装目录（例如旧版本）的数据只读复制到本目录的新数据库。原目录和原数据卷都不会被修改。'
    $From = Read-Host '原安装目录（例如 D:\SEO-Local）'
}
$From = [IO.Path]::GetFullPath($From.Trim().Trim('"')).TrimEnd('\')
if ($From -ieq $script:SeoRoot.TrimEnd('\')) { throw '原安装目录不能是本目录。' }
foreach ($file in @('.env', 'compose.local.yml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $From $file) -PathType Leaf)) { throw "原安装目录中没有 $file：$From" }
}
$oldEnv = Read-SeoEnvFile (Join-Path $From '.env')
$oldCompose = [IO.File]::ReadAllText((Join-Path $From 'compose.local.yml'))
function Get-OldSetting([string]$Name, [string]$Fallback) {
    # The other installation's .env, else the default written in its compose file.
    if ($oldEnv.Contains($Name) -and $oldEnv[$Name].Value) { return $oldEnv[$Name].Value }
    $default = [regex]::Match($oldCompose, '\$\{' + [regex]::Escape($Name) + ':-([A-Za-z0-9_.-]+)\}')
    if ($default.Success) { return $default.Groups[1].Value }
    return $Fallback
}
$project = [regex]::Match($oldCompose, '(?m)^name:\s*["'']?([a-z0-9][a-z0-9_-]*)["'']?\s*$')
if (-not $project.Success) { throw '无法从原目录的 compose.local.yml 读出项目名。' }
$oldVolume = Get-OldSetting 'ABORDER_DB_VOLUME' ($project.Groups[1].Value + '_pgdata')
$oldUser = Get-OldSetting 'POSTGRES_USER' 'postgres'
$oldDb = Get-OldSetting 'POSTGRES_DB' $oldUser
foreach ($value in @($oldUser, $oldDb)) { if ($value -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,62}$') { throw '原安装的数据库用户名或库名含有意外字符。' } }
if ($oldVolume -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$') { throw '原安装的数据卷名含有意外字符。' }

Assert-SeoDocker
Assert-SeoImage
if (-not (Test-SeoVolume $oldVolume)) { throw "没有找到原数据卷 $oldVolume。" }
$inUse = @(& docker --context $script:SeoDockerContext ps --filter "volume=$oldVolume" --format '{{.Names}}' | Where-Object { $_ })
if ($inUse.Count) { throw "原数据库仍在运行（$($inUse -join '、')）。请先在原目录运行它的停止脚本，再重新运行迁移。" }
$db = Get-SeoDatabase
if (Test-SeoVolume $db.Volume) {
    throw "本目录的数据卷 $($db.Volume) 已经存在，迁移只写入全新的数据卷。确认其中的数据可以丢弃后，先运行 停止服务.cmd，再执行 docker volume rm $($db.Volume)，然后重新迁移。"
}

Write-Host ''
Write-Host "原安装目录：$From"
Write-Host "原数据卷：$oldVolume（只读，不会修改）"
Write-Host "原数据库：用户 $oldUser，库 $oldDb"
Write-Host "新数据卷：$($db.Volume)（新建）"
Write-Host "新数据库：用户 $($db.User)，库 $($db.Name)"
Write-Host '.env：带入 Google 登录、应用密钥 NEXTAUTH_SECRET（用于解密已保存的 Google 令牌和 API Key）、计划任务和告警等设置；数据库、镜像和端口设置保留本目录的。'
if ((Read-Host '输入 YES 开始迁移；其他输入取消') -cne 'YES') { throw '已取消，没有做任何修改。' }

# 1. .env of this installation, with the carried settings.
$base = if (Test-Path -LiteralPath $script:SeoEnvPath) { $script:SeoEnvPath } else { Join-Path $script:SeoRoot '.env.example' }
$lines = [Collections.Generic.List[string]]::new()
$used = [Collections.Generic.HashSet[string]]::new()
foreach ($line in [IO.File]::ReadAllLines($base)) {
    $key = if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') { $Matches[1] } else { $null }
    if ($key -and $key -in $carried -and $oldEnv.Contains($key)) {
        if ($used.Add($key)) { $lines.Add($oldEnv[$key].Line) }
        continue
    }
    $lines.Add($line)
}
$extra = @($oldEnv.Keys | Where-Object { $_ -in $carried -and -not $used.Contains($_) })
if ($extra.Count) {
    $lines.Add('')
    $lines.Add('# 从原安装带过来的设置')
    foreach ($key in $extra) { $lines.Add($oldEnv[$key].Line) }
}
$text = ($lines -join "`r`n") + "`r`n"
$text = $text.Replace('REPLACE_WITH_RANDOM_DB_PASSWORD', (New-SeoRandomHex 24)).Replace('REPLACE_WITH_RANDOM_AUTH_SECRET', (New-SeoRandomHex 32))
Write-SeoPrivateText $script:SeoEnvPath $text
$text = $null
$skipped = @($oldEnv.Keys | Where-Object { $_ -notin $carried })
Write-Host '已更新本目录的 .env。'
if ($skipped.Count) { Write-Host ('没有带入（本目录自己的数据库、镜像、端口设置，或新版本不再使用）：' + ($skipped -join ', ')) }

# 2. Data: a read-only copy of the old volume, read by an isolated PostgreSQL, restored into a new database.
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$copyVolume = "aborder-migrate-$stamp"
$tempName = "aborder-migrate-$stamp"
$copyCreated = $false; $tempStarted = $false; $newCreated = $false
$query = @'
SELECT format('SELECT %L AS table_name, count(*) FROM %I.%I;', tablename, schemaname, tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename;
\gexec
'@
try {
    Write-Host '1/5 复制原数据卷（只读挂载）……'
    Invoke-SeoDocker volume create --label 'aborder-seo.purpose=migration' $copyVolume | Out-Null
    $copyCreated = $true
    Invoke-SeoDocker run --rm --network none --entrypoint sh --mount "type=volume,source=$oldVolume,target=/from,readonly" --mount "type=volume,source=$copyVolume,target=/to" postgres:16-alpine -c 'cp -a /from/. /to/'
    $pgVersion = ((& docker --context $script:SeoDockerContext run --rm --network none --entrypoint cat --mount "type=volume,source=$copyVolume,target=/data,readonly" postgres:16-alpine /data/PG_VERSION) -join '').Trim()
    if ($LASTEXITCODE -ne 0 -or $pgVersion -notmatch '^\d{1,2}$') { throw '原数据卷里不是 PostgreSQL 数据目录。' }

    Write-Host '2/5 在隔离环境（无网络）中读取副本并导出……'
    Invoke-SeoDocker run -d --name $tempName --network none --label 'aborder-seo.purpose=migration' --mount "type=volume,source=$copyVolume,target=/var/lib/postgresql/data" "postgres:$pgVersion-alpine" | Out-Null
    $tempStarted = $true
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        & docker --context $script:SeoDockerContext exec $tempName pg_isready -U $oldUser -d $oldDb *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw '隔离数据库没有在 60 秒内启动。' }
    Invoke-SeoDocker exec $tempName pg_dump "--username=$oldUser" "--dbname=$oldDb" --format=custom --file=/tmp/migrate.dump
    Invoke-SeoDocker exec $tempName pg_restore --list /tmp/migrate.dump | Out-Null
    $backupDir = Join-Path $script:SeoRoot "backups\migrate-$stamp"
    New-Item -ItemType Directory -Path $backupDir | Out-Null
    Set-SeoPrivateAcl $backupDir
    $dump = Join-Path $backupDir 'database.dump'
    Invoke-SeoDocker cp "${tempName}:/tmp/migrate.dump" $dump
    $sha = (Get-FileHash -LiteralPath $dump -Algorithm SHA256).Hash
    [pscustomobject]@{ CreatedAt = (Get-Date).ToString('o'); Kind = 'migration'; SourceVolume = $oldVolume; DumpSHA256 = $sha; DumpBytes = (Get-Item -LiteralPath $dump).Length } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDir 'manifest.json') -Encoding utf8

    Write-Host '3/5 写入本目录的新数据库……'
    Invoke-SeoDocker volume create --label 'com.aborder-seo.role=database' $db.Volume | Out-Null
    $newCreated = $true
    Invoke-SeoCompose up -d --wait --wait-timeout 120 db
    Invoke-SeoCompose cp $dump 'db:/tmp/migrate.dump'
    try {
        Invoke-SeoCompose exec -T db pg_restore "--username=$($db.User)" "--dbname=$($db.Name)" --exit-on-error --no-owner --no-privileges /tmp/migrate.dump
    } finally { & docker @script:SeoCompose exec -T db rm -f /tmp/migrate.dump | Out-Null }

    Write-Host '4/5 核对每张表的记录数……'
    $oldCounts = @($query | & docker --context $script:SeoDockerContext exec -i $tempName psql -U $oldUser -d $oldDb -tA -v ON_ERROR_STOP=1 | Where-Object { $_ -match '^[^|]+\|\d+$' })
    if ($LASTEXITCODE -ne 0) { throw '原数据库计数失败。' }
    $newCounts = @($query | & docker @script:SeoCompose exec -T db psql -U $db.User -d $db.Name -tA -v ON_ERROR_STOP=1 | Where-Object { $_ -match '^[^|]+\|\d+$' })
    if ($LASTEXITCODE -ne 0) { throw '新数据库计数失败。' }
    if (-not $oldCounts.Count) { throw '原数据库里没有数据表。' }
    if (Compare-Object $oldCounts $newCounts) { throw '新旧数据库的记录数不一致。' }

    Write-Host '5/5 升级数据库结构……'
    Update-SeoDatabaseSchema -SkipBackup
} catch {
    if ($newCreated) {
        Write-Host "迁移没有完成。原数据卷 $oldVolume 没有改动；本目录的新数据卷 $($db.Volume) 可能只写入了一部分。"
        Write-Host "先运行 停止服务.cmd，再执行 docker volume rm $($db.Volume)，然后重新迁移。"
    }
    throw
} finally {
    if ($tempStarted) { & docker --context $script:SeoDockerContext rm -f $tempName | Out-Null }
    if ($copyCreated) { & docker --context $script:SeoDockerContext volume rm $copyVolume | Out-Null }
}

# 3. Encrypted local credentials (DPAPI: readable by this Windows user only), unless already set here.
foreach ($file in @('mcp-token.dpapi', 'content-worker-token.dpapi')) {
    $source = Join-Path $From "private\$file"
    $target = Join-Path $script:SeoRoot "private\$file"
    if ((Test-Path -LiteralPath $source -PathType Leaf) -and -not (Test-Path -LiteralPath $target)) {
        $null = Initialize-SeoPrivateDirectory
        Copy-Item -LiteralPath $source -Destination $target
        Set-SeoPrivateAcl $target
    }
}

Write-Host ''
Write-Host "迁移完成：$($oldCounts.Count) 张表的记录数一致。迁移时导出的数据另存在 $backupDir。"
Write-Host "原目录和原数据卷没有改动。确认新版本工作正常后，可以自行删除原数据卷：docker volume rm $oldVolume"
Write-Host '下一步：'
Write-Host '  1. 运行 启动服务.cmd。'
Write-Host '  2. 使用账号模式或内容 Worker 时，运行 登录ChatGPT.cmd 登录专用 ChatGPT 账号。'
Write-Host '  3. 如果用过后台的“ChatGPT 连接”，断开后重新连接一次，授权页上的应用名称会随之更新。'
