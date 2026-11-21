#requires -Version 7.3
$ErrorActionPreference = 'Stop'
$package = Join-Path $PSScriptRoot '../desktop/node_modules/electron'
# Electron 45 downloads its test runtime on demand. The packager keeps a separate cache.
& node (Join-Path $package 'install.js') | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Could not install the locked Electron runtime for the startup test.' }
$runtime = Get-Item -LiteralPath (Join-Path $package 'dist/electron.exe')
$runtime.FullName
