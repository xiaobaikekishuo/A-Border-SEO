#requires -Version 7.0
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-SeoEnvFile
$record=[ordered]@{CheckedAt=(Get-Date).ToString('o');Root=$script:SeoRoot;MakesModelCalls=$false}
$settings=[IO.File]::ReadAllText($script:SeoEnvPath)
$record.GoogleConfigured=($settings -notmatch 'REPLACE_WITH_GOOGLE')
$record.RegistrationClosed=[regex]::IsMatch($settings,'(?m)^DISABLE_REGISTRATION=true\r?$')
$record.SchedulerDisabled=[regex]::IsMatch($settings,'(?m)^SCHEDULER_ENABLED=false\r?$')
$record.ModelKeyInApplicationEnv=[regex]::IsMatch($settings,'(?m)^(OPENAI_API_KEY|CODEX_API_KEY)=')
$record.ContentWorkerTokenSet=[regex]::IsMatch($settings,'(?m)^LOCAL_CONTENT_WORKER_TOKEN=[A-Za-z0-9_-]{32,}')
$settings=$null
$db=Get-SeoDatabase
$record.Image=Get-SeoImageName
$record.DatabaseVolume=$db.Volume
try {
    $record.Services=@(Invoke-SeoCompose ps --all --format json | ForEach-Object {$_|ConvertFrom-Json} | Select-Object Service,State,Health,Publishers)
    $config=(Invoke-SeoCompose config --format json)-join "`n"|ConvertFrom-Json
    $record.AppBindings=$config.services.app.ports
    $record.DatabasePublished=(@($config.services.db.ports).Where({$null -ne $_}).Count -gt 0)
    $record.LogLimits=$config.services.app.logging.options
    $config=$null
    $counts=Invoke-SeoPsql 'SELECT (SELECT count(*) FROM "User"), (SELECT count(*) FROM "Site"), (SELECT count(*) FROM "Crawl"), (SELECT count(*) FROM "Keyword"), (SELECT count(*) FROM "_prisma_migrations");'
    $numbers=($counts -join '').Trim() -split '\|'
    $record.DatabaseCounts=@{Users=[int]$numbers[0];Sites=[int]$numbers[1];Crawls=[int]$numbers[2];KeywordRows=[int]$numbers[3];Migrations=[int]$numbers[4]}
} catch {$record.DockerOrDatabaseCheck='FAILED; inspect locally with Docker Desktop'}
try {$record.HttpHealth=Invoke-RestMethod -Uri ((Get-SeoBaseUrl)+'/api/health') -NoProxy -TimeoutSec 5} catch {$record.HttpHealth=@{status='unavailable'}}
# The user's own Codex configuration must stay exactly as it was when this kit was first started.
$original=Join-Path $HOME '.codex\config.toml'
$infoPath=Join-Path $script:SeoRoot 'deployment-info.json'
if(Test-Path -LiteralPath $infoPath){
    $baseline=Get-Content -LiteralPath $infoPath -Raw|ConvertFrom-Json
    $current=if(Test-Path -LiteralPath $original -PathType Leaf){(Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash}else{$null}
    $record.OriginalCodexConfigUnchanged=($baseline.OriginalCodexConfigSHA256 -eq $current)
} else {$record.OriginalCodexConfigUnchanged='not recorded yet; run 启动服务.cmd once'}
$record.Auth=@{}
$names=@('CODEX_HOME','OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_BASE_URL','OPENAI_ORG_ID','OPENAI_PROJECT_ID')
$saved=@{};foreach($name in $names){$saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try{
    foreach($name in $names){Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue}
    foreach($mode in @('chatgpt','api')){
        $env:CODEX_HOME=Join-Path $script:SeoRoot "codex\$mode"
        $ignored=& codex login status 2>&1
        $record.Auth[$mode]=@{LoginStatusPassed=($LASTEXITCODE -eq 0);Home=$env:CODEX_HOME}
        $ignored=$null
    }
}finally{
    foreach($name in $names){if($null -eq $saved[$name]){Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')}}
}
$json=$record|ConvertTo-Json -Depth 8
$reports=Join-Path $script:SeoRoot 'reports'
New-Item -ItemType Directory -Force -Path $reports|Out-Null
[IO.File]::WriteAllText((Join-Path $reports 'local-checks.json'),$json,[Text.UTF8Encoding]::new($false))
Write-Output $json
Write-Host '本检查不等于网站同步、抓取或 MCP 工具调用通过。MCP 请运行 检查MCP.cmd，Codex 账号模式请运行 验收账号模式.cmd。'
