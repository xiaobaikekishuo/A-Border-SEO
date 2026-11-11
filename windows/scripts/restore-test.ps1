#requires -Version 7.0
[CmdletBinding()]
param([string]$BackupDirectory='')
. (Join-Path $PSScriptRoot 'common.ps1')
$db=Get-SeoDatabase
$backupsRoot=Join-Path $script:SeoRoot 'backups'
if(-not $BackupDirectory){
    # Without an argument: the newest backup that has a manifest.
    $latest=Get-ChildItem -LiteralPath $backupsRoot -Directory -ErrorAction SilentlyContinue|Where-Object{Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json')}|Sort-Object LastWriteTimeUtc -Descending|Select-Object -First 1
    if(-not $latest){throw '还没有备份。请先运行 备份.cmd。'}
    $BackupDirectory=$latest.FullName
}
$resolved=(Resolve-Path -LiteralPath $BackupDirectory).Path
if(-not $resolved.StartsWith((Join-Path $script:SeoRoot 'backups\'),[StringComparison]::OrdinalIgnoreCase)){throw '只允许恢复本项目 backups 下的归档。'}
$dump=Join-Path $resolved 'database.dump'
$manifest=Get-Content -LiteralPath (Join-Path $resolved 'manifest.json') -Raw|ConvertFrom-Json
if((Get-FileHash -LiteralPath $dump -Algorithm SHA256).Hash -ne $manifest.DumpSHA256){throw '归档校验和不符。'}
Write-Host "演练恢复：$resolved"
$name='aborder-restore-'+(Get-Date -Format 'yyyyMMddHHmmssfff')
$volume=$name+'-data'
$created=$false
function Invoke-TestDocker {
    & docker --context $script:SeoDockerContext @args
    if($LASTEXITCODE -ne 0){throw "隔离恢复 Docker 操作失败 (exit $LASTEXITCODE)。"}
}
try {
    # No published ports, no network, a fresh dedicated volume; production DB is untouched.
    Invoke-TestDocker volume create --label aborder-seo.purpose=restore-test $volume|Out-Null
    Invoke-TestDocker run -d --name $name --network none --label aborder-seo.purpose=restore-test --mount "type=volume,source=$volume,target=/var/lib/postgresql/data" --env "POSTGRES_USER=$($db.User)" --env "POSTGRES_DB=$($db.Name)" --env POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine|Out-Null
    $created=$true
    $ready=$false
    for($i=0;$i -lt 30;$i++){
        & docker --context $script:SeoDockerContext exec $name pg_isready -U $db.User -d $db.Name *> $null
        if($LASTEXITCODE -eq 0){$ready=$true;break}
        Start-Sleep -Seconds 1
    }
    if(-not $ready){throw '隔离数据库启动超时。'}
    Invoke-TestDocker cp $dump "${name}:/tmp/restore.dump"
    Invoke-TestDocker exec $name pg_restore -U $db.User -d $db.Name --exit-on-error --no-owner --no-privileges /tmp/restore.dump
    # Compare every public table's row count; no customer records are printed.
    $query=@'
SELECT format('SELECT %L AS table_name, count(*) FROM %I.%I;', tablename, schemaname, tablename) FROM pg_tables WHERE schemaname='public' ORDER BY tablename;
\gexec
'@
    $sourceCounts=$query | & docker @script:SeoCompose exec -T db psql -U $db.User -d $db.Name -tA -v ON_ERROR_STOP=1
    if($LASTEXITCODE -ne 0){throw '正式库计数检查失败。'}
    $restoredCounts=$query | & docker --context $script:SeoDockerContext exec -i $name psql -U $db.User -d $db.Name -tA -v ON_ERROR_STOP=1
    if($LASTEXITCODE -ne 0){throw '恢复库计数检查失败。'}
    $sourceRows=@($sourceCounts|Where-Object{$_ -match '^[^|]+\|\d+$'})
    $restoredRows=@($restoredCounts|Where-Object{$_ -match '^[^|]+\|\d+$'})
    if($sourceRows.Count -eq 0){throw '没有应用表，不能宣告应用恢复通过。'}
    if(Compare-Object $sourceRows $restoredRows){throw '记录数不一致（若备份后有新数据，请暂停任务并重做备份）。'}
    [pscustomobject]@{At=(Get-Date).ToString('o');Status='passed';TablesCompared=$sourceRows.Count;Rows=$restoredRows;DumpSHA256=$manifest.DumpSHA256;Network='none';PublishedPorts=@()}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $resolved 'restore-test.json') -Encoding utf8
    Write-Host "隔离恢复通过，共核对 $($sourceRows.Count) 张表。"
} finally {
    if($created){& docker --context $script:SeoDockerContext stop --time 20 $name|Out-Null; & docker --context $script:SeoDockerContext rm $name|Out-Null}
    Write-Host "测试容器已停止并移除；专用测试卷 $volume 保留。正式数据库未改动。"
}
