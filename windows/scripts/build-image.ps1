#requires -Version 7.0
[CmdletBinding()]
param([string]$SourceDirectory = '')
. (Join-Path $PSScriptRoot 'common.ps1')
Assert-SeoDocker
if (-not $SourceDirectory) {
    # The release package keeps source\ next to windows\; a copied kit can also hold its own source\.
    foreach ($candidate in @((Join-Path $script:SeoRoot 'source'), (Join-Path (Split-Path -Parent $script:SeoRoot) 'source'))) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'Dockerfile') -PathType Leaf) { $SourceDirectory = $candidate; break }
    }
}
if (-not $SourceDirectory) { $SourceDirectory = (Read-Host '源码目录（含 Dockerfile 的 source 文件夹）').Trim().Trim('"') }
$SourceDirectory = [IO.Path]::GetFullPath($SourceDirectory)
foreach ($file in @('Dockerfile', 'package.json', 'package-lock.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory $file) -PathType Leaf)) { throw "源码目录中没有 $file：$SourceDirectory" }
}
$version = [string](Get-Content -LiteralPath (Join-Path $SourceDirectory 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'package.json 中的版本号无效。' }
$image = "a-border-seo:$version"
Write-Host "构建镜像 $image（源码：$SourceDirectory）。第一次构建要下载基础镜像和依赖，需要几分钟。"
Invoke-SeoDocker build -t $image $SourceDirectory
if (Test-Path -LiteralPath $script:SeoEnvPath -PathType Leaf) {
    Set-SeoEnvValue 'ABORDER_SEO_IMAGE' $image -AddIfMissing
    Write-Host "已在 .env 中改用新镜像：ABORDER_SEO_IMAGE=$image"
}
Write-Host '构建完成。运行 启动服务.cmd 使用新镜像；需要升级数据库结构时会先自动备份。'
