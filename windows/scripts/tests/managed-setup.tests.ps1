#requires -Version 7.3
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$testParent = Join-Path $repo 'reports'
$testDirectory = Join-Path $testParent ('managed-setup-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDirectory -Force | Out-Null
$originalInput = [Console]::In
try {
    . (Join-Path $repo 'windows/scripts/common.ps1') -DataRoot $testDirectory
    . (Join-Path $repo 'windows/scripts/desktop-common.ps1')
    . (Join-Path $repo 'windows/scripts/desktop-lifecycle.ps1')
    $script:DesktopPrivate = Join-Path $testDirectory 'private'
    $script:DesktopLocalPinPath = Join-Path $script:DesktopPrivate 'desktop-local-image.json'
    $script:DesktopManagedDirectory = Join-Path $script:DesktopPrivate 'managed'
    $script:DesktopManagedRequired = $true
    New-Item -ItemType Directory -Path $script:DesktopPrivate -Force | Out-Null
    function Assert-DesktopDocker {}
    function Assert-DesktopReleaseImage {}
    function Assert-DesktopManagedImage {}
    function Get-DesktopProjectContainers { return @{} }
    function Get-SeoDatabase { return @{ Volume = 'isolated-fixture-only' } }
    function Test-SeoVolume { return $false }
    function Test-DesktopPort { return $true }
    function Initialize-DesktopVolume {}
    function Get-DesktopStatus { return @{ configured = (Test-Path $script:SeoEnvPath) } }
    [Console]::SetIn([IO.StringReader]::new('{"createVolume":true}'))
    $status = Initialize-DesktopSetup 'fixture-image' '' '1.4.0'
    if (-not $status.configured) { throw 'Managed setup did not produce a configuration.' }
    if ((Get-SeoEnvValue 'GOOGLE_CLIENT_ID') -or (Get-SeoEnvValue 'GOOGLE_CLIENT_SECRET')) { throw 'Managed setup should leave optional Google credentials empty.' }
    Assert-DesktopConfig
    $before = (Get-FileHash $script:SeoEnvPath).Hash
    $blocked = $false
    try { Initialize-DesktopSetup 'fixture-image' '' '1.4.0' | Out-Null }
    catch { $blocked = $_.Exception.Data['desktopCode'] -eq 'already_configured' }
    if (-not $blocked -or (Get-FileHash $script:SeoEnvPath).Hash -ne $before) { throw 'Existing configuration was not protected.' }
    $script:DesktopManagedRequired = $false
    $rejected = $false
    try { Assert-DesktopConfig }
    catch { $rejected = $_.Exception.Data['desktopCode'] -eq 'google_config_missing' }
    if (-not $rejected) { throw 'Unmanaged configuration incorrectly bypassed Google requirements.' }
    Write-Output 'PASS managed setup without Google, existing-config protection, unmanaged Google requirement.'
} finally {
    [Console]::SetIn($originalInput)
    $resolved = [IO.Path]::GetFullPath($testDirectory)
    if ([IO.Path]::GetDirectoryName($resolved) -ine [IO.Path]::GetFullPath($testParent) -or
        [IO.Path]::GetFileName($resolved) -cnotmatch '^managed-setup-[a-f0-9]{32}$') { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
