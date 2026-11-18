#requires -Version 7.3
[CmdletBinding()]
param([string]$ArchivePath)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $IsWindows) { throw 'Stage the Windows x64 PowerShell runtime on Windows.' }

# PowerShell 7.6 LTS, from https://github.com/PowerShell/PowerShell/releases/tag/v7.6.10
$version = '7.6.10'
$archiveName = "PowerShell-$version-win-x64.zip"
$expectedHash = '7D871531806EB1646264E4BBABD9F0C30C23355591BC756BB9909448C29AE166'
$buildPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../desktop/build'))
$build = New-Item -ItemType Directory -Path $buildPath -Force
if ($build.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'The desktop build directory must be a local directory.'
}

$destination = Join-Path $build.FullName 'powershell'
$temporary = New-Item -ItemType Directory -Path (Join-Path $build.FullName ('.powershell-' + [guid]::NewGuid().ToString('N')))
$candidate = Join-Path $temporary.FullName 'payload'
$previous = Join-Path $temporary.FullName 'previous'
try {
    if ($ArchivePath) {
        $archive = (Get-Item -LiteralPath $ArchivePath).FullName
    } else {
        $archive = Join-Path $temporary.FullName $archiveName
        Invoke-WebRequest -Uri "https://github.com/PowerShell/PowerShell/releases/download/v$version/$archiveName" `
            -MaximumRedirection 4 -TimeoutSec 180 -OutFile $archive
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -cne $expectedHash) {
        throw "The PowerShell $version x64 archive does not match the publisher's SHA-256."
    }

    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $candidate)
    foreach ($name in @('pwsh.exe', 'LICENSE.txt', 'ThirdPartyNotices.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $candidate $name) -PathType Leaf)) {
            throw "The PowerShell archive is missing $name."
        }
    }
    $actual = & (Join-Path $candidate 'pwsh.exe') -NoLogo -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()'
    if ($LASTEXITCODE -ne 0 -or $actual -cne $version) { throw "PowerShell $version did not start." }

    if (Test-Path -LiteralPath $destination) {
        $existing = Get-Item -LiteralPath $destination
        if (-not $existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The PowerShell staging destination must be a local directory.'
        }
        [IO.Directory]::Move($existing.FullName, $previous)
    }
    try {
        [IO.Directory]::Move($candidate, $destination)
    } catch {
        if (Test-Path -LiteralPath $previous) { [IO.Directory]::Move($previous, $destination) }
        throw
    }
} finally {
    $resolved = (Get-Item -LiteralPath $temporary.FullName).FullName
    if ([IO.Path]::GetDirectoryName($resolved) -ceq $build.FullName -and
        [IO.Path]::GetFileName($resolved) -cmatch '^\.powershell-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

Write-Output "PowerShell $version x64 staged in desktop/build/powershell."
