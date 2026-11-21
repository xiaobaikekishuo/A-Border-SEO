#requires -Version 7.3
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Version,
    [string]$OutputDirectory,
    [string]$ReleaseManifest,
    [string]$Publisher,
    [switch]$Hosted,
    [switch]$InstallSmoke
)

$ErrorActionPreference = 'Stop'
if ($Version -cnotmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
$desktop = Join-Path $PSScriptRoot '../desktop'
$dist = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $desktop 'dist' }
$name = "A-Border-SEO-Setup-$Version-x64.exe"
$installer = Join-Path $dist $name
$blockmap = "$installer.blockmap"
$manifestPath = if ($ReleaseManifest) { [IO.Path]::GetFullPath($ReleaseManifest) } else { Join-Path $desktop 'release-manifest.json' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$packagedManifest = Join-Path $dist 'win-unpacked/resources/release-manifest.json'
$packagedPowerShell = Join-Path $dist 'win-unpacked/resources/powershell/pwsh.exe'
$managementConfig = Join-Path $desktop 'build/management-config.json'

function Read-UpdateYaml([string]$Path) {
    # Use the same YAML parser as electron-builder and electron-updater.
    $readYaml = @'
const [filename, directory] = process.argv.slice(1);
const yaml = require(require.resolve("js-yaml", { paths: [directory] }));
const { readFileSync } = require("node:fs");
console.log(JSON.stringify(yaml.load(readFileSync(filename, "utf8"))));
'@
    $json = & node -e $readYaml $Path $desktop
    if ($LASTEXITCODE -ne 0) { throw "Could not read $Path." }
    $json | ConvertFrom-Json
}

$metadata = Read-UpdateYaml (Join-Path $dist 'latest.yml')
$feed = Read-UpdateYaml (Join-Path $dist 'win-unpacked/resources/app-update.yml')

foreach ($file in @($installer, $blockmap)) {
    if ((Get-Item -LiteralPath $file).Length -lt 1) { throw "Empty file $file." }
}
function Test-HostedResources([string]$Resources) {
    & node (Join-Path $PSScriptRoot 'verify-hosted-payload.mjs') $Resources
    if ($LASTEXITCODE -ne 0) { throw 'The hosted application differs from the source being released.' }
    foreach ($legacy in @('windows', 'powershell', 'release-manifest.json')) {
        if (Test-Path -LiteralPath (Join-Path $Resources $legacy)) { throw "Unexpected hosted resource: $legacy." }
    }
    foreach ($file in @('app.asar', 'app-update.yml', 'managed-protocol.mjs', 'local-worker/index.mjs', 'local-worker/lib.mjs', 'local-worker/app-server.mjs')) {
        if ((Get-Item -LiteralPath (Join-Path $Resources $file)).Length -lt 1) { throw "Empty hosted resource: $file." }
    }
    foreach ($pair in @(
        @{ Name = 'hosted-workspace.json'; Source = (Join-Path $desktop 'hosted-workspace.json') },
        @{ Name = 'management-config.json'; Source = $managementConfig }
    )) {
        if ((Get-FileHash -LiteralPath (Join-Path $Resources $pair.Name)).Hash -cne (Get-FileHash -LiteralPath $pair.Source).Hash) {
            throw "Hosted resource differs from its staged input: $($pair.Name)."
        }
    }
    $config = Get-Content -LiteralPath (Join-Path $Resources 'hosted-workspace.json') -Raw | ConvertFrom-Json
    if ($manifest.desktopMode -cne 'hosted' -or $config.workspaceOrigin -cne $manifest.workspaceOrigin) {
        throw 'The release manifest does not describe the installed workspace.'
    }
}
if ($Hosted) {
    Test-HostedResources (Join-Path $dist 'win-unpacked/resources')
} else {
    $runtimeVersion = & $packagedPowerShell -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()'
    if ($LASTEXITCODE -ne 0 -or [version]$runtimeVersion -lt [version]$manifest.minimumPowerShell) {
        throw 'The bundled PowerShell runtime did not start or does not meet the controller minimum version.'
    }
}
$hash = [Convert]::ToBase64String([Convert]::FromHexString((Get-FileHash -LiteralPath $installer -Algorithm SHA512).Hash))
if ($metadata.version -cne $Version -or $metadata.path -cne $name -or $metadata.sha512 -cne $hash -or
    @($metadata.files).Count -ne 1 -or $metadata.files[0].url -cne $name -or
    $metadata.files[0].sha512 -cne $hash -or $metadata.files[0].size -ne (Get-Item -LiteralPath $installer).Length) {
    throw 'latest.yml does not match the installer.'
}
if ($manifest.version -cne $Version -or $manifest.backendVersion -cne $Version -or
    (-not $Hosted -and (Get-FileHash -LiteralPath $manifestPath).Hash -cne (Get-FileHash -LiteralPath $packagedManifest).Hash)) {
    throw 'The installer must contain the matching release manifest.'
}
if (Test-Path -LiteralPath $managementConfig -PathType Leaf) {
    $packedManagement = Join-Path $dist 'win-unpacked/resources/management-config.json'
    if ((Get-FileHash -LiteralPath $managementConfig).Hash -cne (Get-FileHash -LiteralPath $packedManagement).Hash) {
        throw 'The installer must contain the staged management trust configuration.'
    }
}
if ($feed.provider -cne 'github' -or $feed.owner -cne 'xiaobaikekishuo' -or $feed.repo -cne 'A-Border-SEO') {
    throw 'Unexpected update feed.'
}

$versionInfo = (Get-Item -LiteralPath $installer).VersionInfo
if ($versionInfo.ProductVersion -cnotin @($Version, "$Version.0")) {
    throw "Unexpected installer ProductVersion $($versionInfo.ProductVersion)."
}
if ($Publisher) {
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or
        $signature.SignerCertificate.GetNameInfo('SimpleName', $false) -cne $Publisher) {
        throw "Installer Authenticode verification failed ($($signature.Status))."
    }
    if ($Publisher -cnotin @($feed.publisherName)) {
        throw 'The installed update feed does not pin the Authenticode publisher.'
    }
}

if ($InstallSmoke) {
    if ($Hosted) { $electron = & (Join-Path $PSScriptRoot 'resolve-smoke-electron.ps1') }
    $product = 'A-Border SEO'
    # NSIS derives this GUID from the immutable appId com.aborder.seo.
    $productGuid = 'a5e389d3-f855-5880-a3cd-8c05bca8902c'
    $registryRoots = @('HKCU:\Software', 'HKLM:\Software', 'HKCU:\Software\WOW6432Node', 'HKLM:\Software\WOW6432Node')
    foreach ($registryRoot in $registryRoots) {
        $uninstallRoot = Join-Path $registryRoot 'Microsoft\Windows\CurrentVersion\Uninstall'
        $guidKey = Join-Path $registryRoot $productGuid
        $uninstallGuidKey = Join-Path $uninstallRoot $productGuid
        if ((Test-Path -LiteralPath $guidKey) -or (Test-Path -LiteralPath $uninstallGuidKey)) {
            throw 'Use a Windows profile without an existing A-Border SEO installation.'
        }
        $existingProduct = Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue |
            Where-Object { (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).DisplayName -match '^A-Border SEO(?:\s|$)' } |
            Select-Object -First 1
        if ($existingProduct) { throw 'Use a Windows profile without an existing A-Border SEO installation.' }
    }
    foreach ($specialFolder in @('DesktopDirectory', 'CommonDesktopDirectory', 'Programs', 'CommonPrograms')) {
        $folder = [Environment]::GetFolderPath($specialFolder)
        if ($folder -and ((Test-Path -LiteralPath (Join-Path $folder "$product.lnk")) -or
            (Test-Path -LiteralPath (Join-Path $folder $product)))) {
            throw 'Use a Windows profile without existing A-Border SEO shortcuts.'
        }
    }
    $profile = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $product
    if (Test-Path -LiteralPath $profile) { throw 'This Windows profile already has A-Border SEO user data.' }
    if (Get-Process -Name $product -ErrorAction SilentlyContinue) { throw 'Close all A-Border SEO processes before installer smoke testing.' }

    $installDir = Join-Path ([IO.Path]::GetTempPath()) ("aborder-installer-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $profile | Out-Null
    $marker = Join-Path $profile 'installer-data-retention.txt'
    Set-Content -LiteralPath $marker -Value 'disposable installer smoke marker'
    $uninstaller = Join-Path $installDir 'Uninstall A-Border SEO.exe'
    try {
        $process = Start-Process -FilePath $installer -ArgumentList '/S', '/currentuser', "/D=$installDir" -PassThru -Wait -WindowStyle Hidden
        if ($process.ExitCode -ne 0) { throw "NSIS setup failed with exit code $($process.ExitCode)." }
        foreach ($file in @('A-Border SEO.exe', 'resources/app.asar')) {
            if (-not (Test-Path -LiteralPath (Join-Path $installDir $file) -PathType Leaf)) { throw "Setup did not install $file." }
        }
        if ($Hosted) {
            $installedResources = Join-Path $installDir 'resources'
            Test-HostedResources $installedResources
            $smokeProfile = Join-Path ([IO.Path]::GetTempPath()) ("aborder-smoke-" + [guid]::NewGuid().ToString('N'))
            $harness = Join-Path $desktop 'test/packaged-hosted-smoke.cjs'
            $mode = if ($Publisher) { 'signed' } else { 'unsigned' }
            $process = Start-Process -FilePath $electron -ArgumentList @("`"$harness`"", "`"$installedResources`"", "`"$smokeProfile`"", $mode) -WindowStyle Hidden -PassThru -Wait
            $result = Get-Content -LiteralPath (Join-Path $smokeProfile 'packaged-smoke-result.json') -Raw | ConvertFrom-Json
            if ($process.ExitCode -ne 0 -or $result.pass -ne $true -or $result.observed.currentVersion -cne $Version) {
                throw 'The installed hosted application failed its isolated startup check.'
            }
        } else {
            $installedManifest = Join-Path $installDir 'resources/release-manifest.json'
            if ((Get-FileHash -LiteralPath $manifestPath).Hash -cne (Get-FileHash -LiteralPath $installedManifest).Hash -or
                -not (Test-Path -LiteralPath (Join-Path $installDir 'resources/powershell/pwsh.exe') -PathType Leaf)) {
                throw 'The installed backend management resources differ from the release.'
            }
        }
    } finally {
        if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
            $process = Start-Process -FilePath $uninstaller -ArgumentList '/S', '/currentuser' -PassThru -Wait -WindowStyle Hidden
            if ($process.ExitCode -ne 0) { throw "NSIS uninstaller failed with exit code $($process.ExitCode)." }
        }
    }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'Uninstall removed the user data marker.' }
    if (Test-Path -LiteralPath (Join-Path $installDir 'A-Border SEO.exe')) { throw 'Uninstall left the application installed.' }
    Remove-Item -LiteralPath $marker
    if (-not (Get-ChildItem -LiteralPath $profile -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $profile }
    Write-Output 'Silent per-user installation, uninstall and user data retention verified.'
}

Write-Output "Installer metadata and packaged manifest verified for $Version."
