#requires -Version 7.3
[CmdletBinding()]
param([Parameter(Mandatory)][string]$BackupDirectory, [Parameter(Mandatory)][string]$Destination, [string]$DataRoot = '')
. (Join-Path $PSScriptRoot 'common.ps1') -DataRoot $DataRoot
$backup=(Resolve-Path -LiteralPath $BackupDirectory).Path
if(-not $backup.StartsWith((Join-Path $script:SeoRoot 'backups\'),[StringComparison]::OrdinalIgnoreCase)){throw '只允许读取本项目备份目录。'}
$fullDestination=[IO.Path]::GetFullPath($Destination)
if(-not $fullDestination.StartsWith((Join-Path $script:SeoRoot 'private\'),[StringComparison]::OrdinalIgnoreCase)){throw '解密目标必须在本项目 private 目录中。'}
if(Test-Path -LiteralPath $fullDestination){throw '目标已存在，不覆盖。'}
$bytes=$null
try{
    $bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes((Join-Path $backup 'env.dpapi')),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $empty = [IO.File]::Open($fullDestination, [IO.FileMode]::CreateNew)
    $empty.Dispose()
    Set-SeoPrivateAcl $fullDestination
    [IO.File]::WriteAllBytes($fullDestination,$bytes)
    Write-Host '已解密到指定的本机私有文件，没有替换正在使用的 .env。'
}finally{if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}}
