#requires -Version 7.3
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$SevenZipPath = '7z.exe'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$out = (Resolve-Path -LiteralPath $OutputDirectory).Path
$sevenZip = (Get-Command $SevenZipPath -CommandType Application -ErrorAction Stop).Source
$file = "A-Border-SEO-Setup-$Version-x64.exe"
$installer = Join-Path $out $file
$manifest = Join-Path $out 'desktop-release.json'
$signature = Get-AuthenticodeSignature -LiteralPath $installer
$verify = @{ Version = $Version; Hosted = $true; OutputDirectory = $out; ReleaseManifest = $manifest }
$mode = 'unsigned'
switch ($signature.Status.ToString()) {
    Valid { $verify.Publisher = $signature.SignerCertificate.GetNameInfo('SimpleName', $false); $mode = 'signed' }
    NotSigned { }
    default { throw "Unacceptable installer signature: $($signature.Status)." }
}
& (Join-Path $PSScriptRoot 'verify-installer.ps1') @verify

$scratch = [IO.Directory]::CreateTempSubdirectory('aborder-website-installer-').FullName
try {
    # Inspect the bytes in the final download. NSIS embeds the application's 7z in its plugin directory.
    & $sevenZip e -y "-o$scratch" -- $installer '$PLUGINSDIR/app-64.7z' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to extract the NSIS payload.' }
    & $sevenZip x -y "-o$scratch" -- (Join-Path $scratch 'app-64.7z') 'resources/*' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to extract the packaged resources.' }
    $resources = Join-Path $scratch 'resources'
    $expected = @('app-update.yml', 'app.asar', 'default_app.asar', 'elevate.exe', 'hosted-workspace.json',
        'icon.png', 'LICENSE.txt', 'local-worker/index.mjs', 'local-worker/lib.mjs', 'local-worker/app-server.mjs', 'managed-protocol.mjs', 'management-config.json')
    $actual = @(Get-ChildItem -LiteralPath $resources -File -Recurse -Force | ForEach-Object {
        [IO.Path]::GetRelativePath($resources, $_.FullName).Replace('\', '/')
    })
    if (Compare-Object $expected $actual -CaseSensitive) { throw 'Unexpected hosted installer resources.' }
    foreach ($name in $expected) {
        $packed = (Get-FileHash -LiteralPath (Join-Path $resources $name)).Hash
        $staged = (Get-FileHash -LiteralPath (Join-Path $out "win-unpacked/resources/$name")).Hash
        if ($packed -ne $staged) { throw "NSIS payload differs from verified staging: $name." }
    }
    & node (Join-Path $PSScriptRoot 'verify-hosted-payload.mjs') $resources --public-release
    if ($LASTEXITCODE -ne 0) { throw 'Final hosted payload failed verification.' }

    $profile = Join-Path $scratch 'isolated-profile'
    $smoke = Join-Path $root 'desktop/test/packaged-hosted-smoke.cjs'
    $electron = & (Join-Path $PSScriptRoot 'resolve-smoke-electron.ps1')
    $process = [Diagnostics.ProcessStartInfo]::new($electron)
    $process.UseShellExecute = $false
    $process.CreateNoWindow = $true
    $process.WindowStyle = 'Hidden'
    foreach ($arg in @($smoke, $resources, $profile, $mode)) { $process.ArgumentList.Add($arg) }
    $child = [Diagnostics.Process]::Start($process)
    try {
        if (!$child.WaitForExit(60000)) { $child.Kill($true); $child.WaitForExit(); throw 'Packaged startup timed out.' }
        if ($child.ExitCode -ne 0) { throw 'Packaged startup failed.' }
    } finally { $child.Dispose() }
    $check = Get-Content -Raw -LiteralPath (Join-Path $profile 'packaged-smoke-result.json') | ConvertFrom-Json
    if (!$check.pass -or $check.observed.currentVersion -cne $Version) { throw 'Incorrect packaged startup result.' }
    $sum = (Get-FileHash -LiteralPath $installer).Hash.ToLowerInvariant()
    $record = [ordered]@{
        version = $Version; installerSha256 = $sum
        nsisAsarSha256 = (Get-FileHash -LiteralPath (Join-Path $resources 'app.asar')).Hash.ToLowerInvariant()
        modulesAndUiMatch = $true; workerAndTrustMatch = $true; allPackagedResourcesVerified = $actual.Count
        signature = $signature.Status.ToString(); fileSize = (Get-Item -LiteralPath $installer).Length
        workspaceOrigin = $check.observed.workspaceOrigin; automaticUpdatesAvailable = $check.observed.automaticUpdatesAvailable
        packagedSmokePassed = $true
    }
    $check | Select-Object pass,electronVersion,blockedRequests,observed | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath (Join-Path $out 'packaged-smoke-result.json') -Encoding utf8
    $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'verified-payload.json') -Encoding utf8
    $sumsFile = Join-Path $out 'SHA256SUMS.txt'
    $existing = if (Test-Path -LiteralPath $sumsFile) { Get-Content -LiteralPath $sumsFile }
    $filePattern = '^(?<hash>[0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($file) + '$'
    $entries = @($existing | Where-Object { $_ -match $filePattern })
    if ($entries.Count -gt 1 -or ($entries.Count -eq 1 -and $entries[0].Substring(0, 64) -ine $sum)) {
        throw 'An existing SHA256SUMS entry conflicts with this installer.'
    }
    if ($entries.Count -eq 0) {
        $lines = @($existing | Where-Object { $null -ne $_ }) + "$sum  $file"
        $lines | Set-Content -LiteralPath $sumsFile -Encoding utf8
    }
    Write-Output "Verified the Windows $Version download and saved its website release metadata."
} finally {
    $resolved = (Resolve-Path -LiteralPath $scratch).Path
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
    if ($resolved -ceq $scratch -and [IO.Path]::GetDirectoryName($resolved) -ieq $tempRoot) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
