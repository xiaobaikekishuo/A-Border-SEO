#requires -Version 7.0
[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'common.ps1')
$db=Get-SeoDatabase
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$backupDir=Join-Path $script:SeoRoot "backups\$stamp"
New-Item -ItemType Directory -Path $backupDir|Out-Null
Set-SeoPrivateAcl $backupDir
$containerFile="/tmp/backup-$stamp.dump"
$dump=Join-Path $backupDir 'database.dump'
$envBytes=$null;$roundtrip=$null
try {
    Invoke-SeoCompose exec -T db pg_dump "--username=$($db.User)" "--dbname=$($db.Name)" --format=custom "--file=$containerFile"
    Invoke-SeoCompose exec -T db pg_restore --list $containerFile|Out-Null
    Invoke-SeoCompose cp "db:$containerFile" $dump
    if((Get-Item -LiteralPath $dump).Length -eq 0){throw '备份为空。'}
    $envBytes=[IO.File]::ReadAllBytes($script:SeoEnvPath)
    try {
        $protected=[Security.Cryptography.ProtectedData]::Protect($envBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllBytes((Join-Path $backupDir 'env.dpapi'),$protected)
        $roundtrip=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        if(-not [Linq.Enumerable]::SequenceEqual[byte]($envBytes,$roundtrip)){throw '环境配置加密回读校验失败。'}
    } finally { if($envBytes){[Array]::Clear($envBytes,0,$envBytes.Length)}; if($roundtrip){[Array]::Clear($roundtrip,0,$roundtrip.Length)} }
    foreach($file in @('compose.local.yml','.env.example','deployment-info.json')){
        $source=Join-Path $script:SeoRoot $file
        if(Test-Path -LiteralPath $source -PathType Leaf){Copy-Item -LiteralPath $source -Destination $backupDir}
    }
    $sha=(Get-FileHash -LiteralPath $dump -Algorithm SHA256).Hash
    $images=Invoke-SeoCompose images --format json
    [pscustomobject]@{CreatedAt=(Get-Date).ToString('o');DumpSHA256=$sha;DumpBytes=(Get-Item -LiteralPath $dump).Length;EnvProtection='Windows DPAPI CurrentUser; same Windows user/profile required; not a portable off-device backup';Images=($images -join "`n")}|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $backupDir 'manifest.json') -Encoding utf8
    Write-Host "备份完成：$backupDir"
    Write-Host "SHA256：$sha"
    Write-Host '未删除旧备份。env.dpapi 仅能由当前 Windows 用户解密，需另行准备可迁移的加密备份。'
    return $backupDir
} finally {
    & docker @script:SeoCompose exec -T db rm -f -- $containerFile | Out-Null
}
