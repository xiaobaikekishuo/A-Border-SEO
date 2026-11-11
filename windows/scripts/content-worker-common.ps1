#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# The local app. content-worker.ps1 replaces it with the port from the kit's .env (LOCAL_APP_PORT).
$script:ContentBaseUrl = 'http://localhost:3300'

function Get-ContentBaseUrl([string]$Root) {
    # Loopback only: the bearer token never leaves this computer.
    $port = 3300
    $envPath = Join-Path $Root '.env'
    if (Test-Path -LiteralPath $envPath -PathType Leaf) {
        foreach ($line in [IO.File]::ReadAllLines($envPath)) {
            if ($line -match '^\s*LOCAL_APP_PORT\s*=\s*["'']?([0-9]{1,5})["'']?\s*$') { $port = [int]$Matches[1] }
        }
    }
    if ($port -lt 1024 -or $port -gt 65535) { throw 'invalid_config' }
    return "http://localhost:$port"
}

function Find-ContentCodexExecutable([string]$InstallRoot, [string[]]$CommandPaths = @()) {
    # Only direct version folders in the official desktop installation are
    # candidates. Never execute an arbitrary program discovered on PATH.
    if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) { throw 'codex_executable_missing' }
    $rootItem = Get-Item -LiteralPath $InstallRoot
    if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'codex_executable_missing' }
    $candidates = @(Get-ChildItem -LiteralPath $rootItem.FullName -Directory |
        Where-Object { $_.Name -cmatch '^[a-f0-9]{16,64}$' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
        Sort-Object LastWriteTimeUtc -Descending |
        ForEach-Object {
            $binary = Join-Path $_.FullName 'codex.exe'
            if (Test-Path -LiteralPath $binary -PathType Leaf) {
                $item = Get-Item -LiteralPath $binary
                if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $item.FullName }
            }
        })
    foreach ($commandPath in $CommandPaths) {
        if ([string]::IsNullOrWhiteSpace($commandPath)) { continue }
        foreach ($candidate in $candidates) {
            if ($candidate.Equals($commandPath, [StringComparison]::OrdinalIgnoreCase)) { return $candidate }
        }
    }
    # A long-running helper can inherit a PATH pointing at a removed version.
    # Fall back to the newest complete installed version, not the stale PATH.
    if ($candidates.Count) { return $candidates[0] }
    throw 'codex_executable_missing'
}

function Resolve-ContentCodexExecutable([string]$ExplicitPath = '') {
    # -CodexExe, else ABORDER_CODEX_BIN, else the newest CLI bundled with the Codex desktop app.
    if ([string]::IsNullOrWhiteSpace($ExplicitPath) -and -not [string]::IsNullOrWhiteSpace($env:ABORDER_CODEX_BIN)) { $ExplicitPath = $env:ABORDER_CODEX_BIN }
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        # Explicit overrides are authoritative: a missing override never causes
        # an implicit switch to another installation.
        if (-not [IO.Path]::IsPathFullyQualified($ExplicitPath) -or $ExplicitPath.Contains('"') -or
            -not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) { throw 'codex_executable_missing' }
        return [IO.Path]::GetFullPath($ExplicitPath)
    }
    $installRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'OpenAI\Codex\bin'
    $commands = @(Get-Command codex.exe -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    return Find-ContentCodexExecutable $installRoot $commands
}

function Set-ContentPrivateAcl([string]$Path) {
    $directory = Test-Path -LiteralPath $Path -PathType Container
    $acl = if ($directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')) {
        $sid = [Security.Principal.SecurityIdentifier]::new($identity)
        $rule = if ($directory) { [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') } else { [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow') }
        $acl.AddAccessRule($rule)
    }
    if ($directory) { [IO.FileSystemAclExtensions]::SetAccessControl([IO.DirectoryInfo]::new($Path), $acl) }
    else { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path), $acl) }
}

function Initialize-ContentRuntime([string]$Root) {
    $runtime = Join-Path ([IO.Path]::GetFullPath($Root)) 'private\content-worker'
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    Set-ContentPrivateAcl $runtime
    return $runtime
}

function Write-ContentState([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12 -Compress), [Text.UTF8Encoding]::new($false))
    Set-ContentPrivateAcl $Path
}

function Write-ContentLog([string]$Runtime, [string]$Event, [string]$JobId = '', [string]$Code = '', [Collections.IDictionary]$CliSummary = $null) {
    # Only event/error codes, validated identifiers, sanitized CLI type counts,
    # and successful-turn numeric usage are logged, never prompts,
    # answers, credentials, CLI streams, server response bodies, or exception text.
    $path = Join-Path $Runtime 'worker.log'
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 262144) {
        Move-Item -LiteralPath $path -Destination "$path.1" -Force
    }
    $entry = @{ time = [DateTime]::UtcNow.ToString('o'); event = $Event; jobId = $JobId; code = $Code }
    if ($null -ne $CliSummary) { $entry.cli = $CliSummary }
    [IO.File]::AppendAllText($path, ($entry | ConvertTo-Json -Depth 8 -Compress) + "`n", [Text.UTF8Encoding]::new($false))
    Set-ContentPrivateAcl $path
}

function ConvertTo-ContentReportedUsage($Value) {
    if ($Value -isnot [Collections.IDictionary]) { return $null }
    $fields = @{ input_tokens = 'inputTokens'; cached_input_tokens = 'cachedInputTokens'; output_tokens = 'outputTokens'; reasoning_output_tokens = 'reasoningTokens' }
    $reported = @{ source = 'CODEX_CLI'; inputTokens = $null; cachedInputTokens = $null; outputTokens = $null; reasoningTokens = $null; totalTokens = $null }
    $known = 0
    foreach ($field in $fields.Keys) {
        if (-not $Value.Contains($field) -or $null -eq $Value[$field]) { continue }
        $count = $Value[$field]
        if (($count -isnot [int] -and $count -isnot [long]) -or $count -lt 0 -or $count -gt 9007199254740991) { return $null }
        $reported[$fields[$field]] = [long]$count
        $known++
    }
    if (-not $known) { return $null }
    if ($null -ne $reported.inputTokens -and $null -ne $reported.cachedInputTokens -and $reported.cachedInputTokens -gt $reported.inputTokens) { return $null }
    if ($null -ne $reported.outputTokens -and $null -ne $reported.reasoningTokens -and $reported.reasoningTokens -gt $reported.outputTokens) { return $null }
    if ($null -ne $reported.inputTokens -and $null -ne $reported.outputTokens) {
        $total = $reported.inputTokens + $reported.outputTokens
        if ($total -gt 9007199254740991) { return $null }
        $reported.totalTokens = $total
    }
    return $reported
}

function Get-ContentCliSummary([string]$JsonLines) {
    $eventTypes = @{}
    $itemTypes = @{}
    $unexpected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $usage = @{}
    $completedTurns = 0
    $reportedUsage = $null
    $laterTurnStarted = $false
    $invalidEvents = 0
    foreach ($line in ($JsonLines -split "`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $event = $line | ConvertFrom-Json -AsHashtable -Depth 50 -ErrorAction Stop }
        catch { $invalidEvents++; continue }
        if ($event -isnot [Collections.IDictionary] -or -not $event.Contains('type') -or $event.type -isnot [string] -or $event.type -cnotmatch '^[a-z][a-z0-9_.]{0,63}$') { $invalidEvents++; continue }
        $eventType = [string]$event.type
        if ($eventType -ceq 'turn.started' -and $completedTurns -gt 0) { $laterTurnStarted = $true }
        if (-not $eventTypes.ContainsKey($eventType)) {
            if ($eventTypes.Count -ge 32) { $invalidEvents++; continue }
            $eventTypes[$eventType] = 0
        }
        $eventTypes[$eventType]++
        if ($event.Contains('item')) {
            $itemType = 'invalid_type'
            if ($event.item -is [Collections.IDictionary] -and $event.item.Contains('type') -and $event.item.type -is [string] -and $event.item.type -cmatch '^[a-z][a-z0-9_]{0,63}$') { $itemType = [string]$event.item.type }
            else { $invalidEvents++ }
            if (-not $itemTypes.ContainsKey($itemType)) {
                if ($itemTypes.Count -ge 32) { $invalidEvents++; continue }
                $itemTypes[$itemType] = 0
            }
            $itemTypes[$itemType]++
            # Error items report diagnostics, including WebSocket fallback, and
            # execute no tool. Exit status and both output validators still apply.
            if ($itemType -notin @('agent_message', 'reasoning', 'plan', 'error')) { $null = $unexpected.Add($itemType) }
        }
        if ($eventType -ceq 'turn.completed') {
            $completedTurns++
            if ($event.Contains('usage')) { $reportedUsage = ConvertTo-ContentReportedUsage $event.usage }
            if ($event.Contains('usage') -and $event.usage -is [Collections.IDictionary]) {
                foreach ($field in @('input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens')) {
                    if (-not $event.usage.Contains($field)) { continue }
                    $count = $event.usage[$field]
                    if (($count -is [int] -or $count -is [long]) -and $count -ge 0 -and $count -le 1000000000) {
                        if (-not $usage.ContainsKey($field)) { $usage[$field] = [long]0 }
                        $usage[$field] += [long]$count
                    }
                }
            }
        }
    }
    # A noninteractive draft is one turn. Extra or failed turns cannot safely
    # be attributed as a complete task total from this event format.
    if ($completedTurns -ne 1 -or $laterTurnStarted -or $eventTypes.ContainsKey('turn.failed') -or ($eventTypes.ContainsKey('turn.started') -and $eventTypes['turn.started'] -ne 1)) { $reportedUsage = $null }
    return @{ eventTypeCounts = $eventTypes; itemTypeCounts = $itemTypes; unexpectedItemTypes = @($unexpected | Sort-Object); completedTurns = $completedTurns; usage = $usage; reportedUsage = $reportedUsage; invalidEventCount = $invalidEvents }
}

function Get-ContentWorkerToken([string]$Root) {
    $path = Join-Path $Root 'private\content-worker-token.dpapi'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'worker_token_missing' }
    $bytes = $null
    try {
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $token = [Text.Encoding]::UTF8.GetString($bytes)
        if ($token -cnotmatch '^[A-Za-z0-9_-]{32,200}$') { throw 'worker_token_invalid' }
        return $token
    } finally { if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) } }
}

function Invoke-ContentApi([string]$Token, [hashtable]$Body) {
    # Fixed loopback destination, no proxy and no redirects prevent bearer leakage.
    try {
        return Invoke-RestMethod -Uri ($script:ContentBaseUrl + '/api/local-content-worker') -Method Post -Headers @{ Authorization = "Bearer $Token" } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 50 -Compress))) -NoProxy -MaximumRedirection 0 -TimeoutSec 12
    } catch { throw 'worker_api_failed' }
}

function New-ContentCodexStartInfo([string]$Executable, [string]$Root, [string]$WorkingDirectory, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = [IO.Path]::GetFullPath($Executable)
    $info.WorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    # Construct an allowlist instead of trying to enumerate every provider/key name.
    $info.Environment.Clear()
    foreach ($name in @('PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (-not [string]::IsNullOrEmpty($value)) { $info.Environment[$name] = $value }
    }
    $info.Environment['CODEX_HOME'] = Join-Path $Root 'codex\chatgpt'
    $info.Environment['NO_PROXY'] = 'localhost,127.0.0.1,::1'
    $info.Environment['TERM'] = 'dumb'
    return $info
}

function Get-ContentCodexArguments([string]$JobDirectory) {
    $arguments = [Collections.Generic.List[string]]::new()
    foreach ($argument in @('--no-daemon', '--ask-for-approval', 'never', 'exec', '--ignore-user-config', '--strict-config', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', '--color', 'never', '-C', $JobDirectory, '--output-schema', (Join-Path $JobDirectory 'schema.json'), '--output-last-message', (Join-Path $JobDirectory 'answer.json'))) { $arguments.Add($argument) }
    foreach ($setting in @('forced_login_method="chatgpt"', 'cli_auth_credentials_store="file"', 'model_provider="openai"', 'model_providers.openai.supports_websockets=false', 'web_search="disabled"', 'mcp_servers={}', 'apps._default.enabled=false', 'project_doc_max_bytes=0', 'model_reasoning_effort="low"')) { $arguments.Add('-c'); $arguments.Add($setting) }
    foreach ($feature in @('shell_tool', 'shell_snapshot', 'apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'view_image', 'code_mode', 'code_mode_host', 'skill_search', 'skill_mcp_dependency_install', 'tool_suggest', 'daemon_auto_start')) { $arguments.Add('--disable'); $arguments.Add($feature) }
    $arguments.Add('--enable'); $arguments.Add('skip_host_skill_discovery')
    $arguments.Add('-')
    return $arguments.ToArray()
}

function Get-ContentProcessRecord([Diagnostics.Process]$Process, [string]$ScriptPath, [string]$InstanceId, [string]$JobDirectory = '') {
    return @{ pid = $Process.Id; startTicks = $Process.StartTime.ToUniversalTime().Ticks.ToString(); executable = $Process.Path; scriptPath = $ScriptPath; instanceId = $InstanceId; jobDirectory = $JobDirectory }
}

function Test-ContentProcessRecord($Record, [string]$Kind, [string]$ExpectedScript, [string]$ExpectedInstance = '') {
    try {
        if (-not $Record -or $Record.pid -le 0) { return $false }
        if ($Record.scriptPath -ine $ExpectedScript) { return $false }
        if ($ExpectedInstance -and $Record.instanceId -cne $ExpectedInstance) { return $false }
        $process = Get-Process -Id $Record.pid -ErrorAction Stop
        if ($process.StartTime.ToUniversalTime().Ticks.ToString() -cne [string]$Record.startTicks -or $process.Path -ine $Record.executable) { return $false }
        $os = Get-CimInstance Win32_Process -Filter "ProcessId=$($Record.pid)"
        if ($Kind -eq 'worker') {
            return $os.CommandLine.Contains($ExpectedScript, [StringComparison]::OrdinalIgnoreCase) -and $os.CommandLine.Contains([string]$Record.instanceId)
        }
        return $os.CommandLine.Contains('--ignore-user-config') -and $os.CommandLine.Contains([string]$Record.jobDirectory, [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Stop-ContentOwnedProcess($Record, [string]$Kind, [string]$ExpectedScript, [string]$ExpectedInstance) {
    if (Test-ContentProcessRecord $Record $Kind $ExpectedScript $ExpectedInstance) {
        $process = Get-Process -Id $Record.pid -ErrorAction Stop
        $process.Kill()
        $null = $process.WaitForExit(5000)
    }
}

function Remove-ContentJobDirectory([string]$Runtime, [string]$Path) {
    $parent = [IO.Path]::GetFullPath($Runtime).TrimEnd('\') + '\'
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^job-[a-f0-9]{32}$') { throw 'unsafe_job_cleanup_path' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}

function Initialize-ContentCapture {
    if ('ABorderContentWorker.Capture' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
namespace ABorderContentWorker {
  public sealed class Capture {
    public volatile bool Overflow;
    private readonly StringBuilder text = new StringBuilder();
    public Task Task { get; private set; }
    public string Text { get { lock(text) { return text.ToString(); } } }
    public Capture(StreamReader reader, int limit) { Task = Read(reader, limit); }
    private async Task Read(StreamReader reader, int limit) {
      var buffer = new char[4096];
      int count;
      while ((count = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0) {
        lock(text) {
          int take = Math.Min(count, Math.Max(0, limit - text.Length));
          if (take > 0) text.Append(buffer, 0, take);
          if (take < count) Overflow = true;
        }
      }
    }
  }
}
'@
}

function Invoke-ContentCodexProcess([Diagnostics.ProcessStartInfo]$StartInfo, [string]$InputText, [int]$TimeoutSeconds, [scriptblock]$Tick, [scriptblock]$OnStart, [scriptblock]$OnPartialOutput = $null) {
    Initialize-ContentCapture
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $StartInfo
    $started = $false
    $stdout = $null
    try {
        $null = $process.Start(); $started = $true
        $stdout = [ABorderContentWorker.Capture]::new($process.StandardOutput, 524288)
        $stderr = [ABorderContentWorker.Capture]::new($process.StandardError, 131072)
        if ($OnStart) { & $OnStart $process }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $inputTask = $process.StandardInput.WriteAsync($InputText)
        $inputClosed = $false
        while (-not $process.HasExited) {
            if (-not $inputClosed -and $inputTask.IsCompleted) {
                $null = $inputTask.GetAwaiter().GetResult()
                $process.StandardInput.Close()
                $inputClosed = $true
            }
            if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw 'generation_timeout' }
            if ($stdout.Overflow -or $stderr.Overflow) { throw 'cli_output_limit' }
            if ($Tick) { & $Tick }
            Start-Sleep -Milliseconds 200
        }
        $process.WaitForExit()
        $null = $stdout.Task.GetAwaiter().GetResult()
        $null = $stderr.Task.GetAwaiter().GetResult()
        if ($stdout.Overflow -or $stderr.Overflow) { throw 'cli_output_limit' }
        return @{ exitCode = $process.ExitCode; stdout = $stdout.Text; stderr = $stderr.Text }
    } catch {
        $processFailure = $_
        if ($null -ne $stdout -and $OnPartialOutput) {
            # The callback may retain only Get-ContentCliSummary's safe metadata.
            # It receives a bounded in-memory snapshot, never a raw log file.
            try { & $OnPartialOutput $stdout.Text } catch { }
        }
        throw $processFailure
    } finally {
        # The still-open Process object identifies only the child started above.
        if ($started -and -not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
        $process.Dispose()
    }
}
