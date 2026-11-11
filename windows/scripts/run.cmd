@echo off
setlocal
rem Runs one PowerShell 7 script of this kit: run.cmd <script.ps1> [arguments]
rem The kit works from any folder: every path is relative to this file.
set "KIT_SCRIPTS=%~dp0"
set "PWSH="
for %%I in (pwsh.exe) do set "PWSH=%%~$PATH:I"
if not defined PWSH if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not defined PWSH if exist "%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe" set "PWSH=%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe"
if not defined PWSH if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" set "PWSH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
if not defined PWSH goto nopwsh
cd /d "%KIT_SCRIPTS%.."
"%PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "%KIT_SCRIPTS%%~1" %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%
:nopwsh
echo PowerShell 7 (pwsh.exe) was not found.
echo Install it with: winget install --id Microsoft.PowerShell --source winget
pause
exit /b 1
