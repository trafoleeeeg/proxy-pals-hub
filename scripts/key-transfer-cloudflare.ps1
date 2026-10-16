#Requires -Version 7.4
[CmdletBinding()]
param(
    [ValidateSet('preflight', 'push')][string]$Command = 'preflight',
    [Parameter(Mandatory = $true)][string]$StateDirectory,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$WranglerConfigDirectory,
    [Parameter(Mandatory = $true)][string]$WranglerCacheDirectory,
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$NodeSha256,
    [Parameter(Mandatory = $true)][string]$WranglerEntry,
    [Parameter(Mandatory = $true)][string]$WranglerEntrySha256,
    [Parameter(Mandatory = $true)][string]$WranglerVersion,
    [switch]$ConfirmProductionKeyWrite
)

# Implementation only: this tool does not install, log in, deploy, or migrate a
# database. A push changes exactly one production secret on one pinned project.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$accountId = '783398cd847a9aa13275dfab6ab2df2c'
$projectName = 'proxy-pals-hub'
$environmentName = 'production'
$reviewedWranglerVersion = '4.151.1'
$reviewedWranglerEntrySha256 = 'a1b3cf7023a53d0d7f7ca4a183f2f904573cdb00737cd1a034890207431f1d8e'
$entropy = [Text.Encoding]::UTF8.GetBytes('Umbra key transfer vault v1')
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$rawSecret = $null
$jsonBytes = $null
$protectedSecret = $null
$nodeLock = $null
$entryLock = $null
$temporary = $null
$lastResult = $null
enum CloudflareTransferStage {
    approval
    paths
    tool_pins
    cli_version
    cli_identity
    cli_project
    vault_validate
    vault_unprotect
    json_encode
    production_write
    cleanup
}
[CloudflareTransferStage]$stage = [CloudflareTransferStage]::approval

function Fail { throw [InvalidOperationException]::new('Cloudflare key transfer validation failed.') }

function Assert-PlainPath([string]$Path, [bool]$Directory) {
    if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path.StartsWith('\\')) { Fail }
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.TrimEnd([IO.Path]::DirectorySeparatorChar) -eq [IO.Path]::GetPathRoot($full).TrimEnd([IO.Path]::DirectorySeparatorChar)) { Fail }
    $cursor = $full
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.LinkType) { Fail }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    $item = Get-Item -LiteralPath $full -Force
    if ([bool]$item.PSIsContainer -ne $Directory) { Fail }
    return $full
}

function Assert-VaultAcl([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { Fail }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 2) { Fail }
    $principals = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($rule in $rules) {
        $identity = $rule.IdentityReference.Value
        if ($identity -notin @($currentSid.Value, 'S-1-5-18') -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or -not $principals.Add($identity)) { Fail }
    }
}

function New-ProtectedDirectory([string]$Path) {
    # Parent was validated. CreateDirectory must not accept an existing target.
    if (-not [UmbraCloudflarePipe]::CreateDirectory($Path, [IntPtr]::Zero)) { Fail }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($currentSid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($currentSid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    Assert-VaultAcl $Path
}

function Read-LockedBytes([IO.FileStream]$Stream, [int]$Maximum) {
    if ($Stream.Length -lt 1 -or $Stream.Length -gt $Maximum) { Fail }
    $Stream.Position = 0
    $bytes = [byte[]]::new([int]$Stream.Length)
    $Stream.ReadExactly($bytes)
    return ,$bytes
}

function Assert-Hash([IO.FileStream]$Stream, [string]$Expected) {
    if ($Expected -cnotmatch '^[a-f0-9]{64}$') { Fail }
    $Stream.Position = 0
    $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Stream)).ToLowerInvariant()
    $Stream.Position = 0
    if ($actual -cne $Expected) { Fail }
}

function Assert-CleanParents([string]$Path) {
    # Do not let a project/config/.env in an ancestor select a different target,
    # override the controlled process environment, or introduce custom behavior.
    $cursor = $Path
    while ($cursor) {
        foreach ($name in @('wrangler.toml', 'wrangler.json', 'wrangler.jsonc', '.env', '.env.production', '.env.local', '.env.production.local', '.dev.vars', '.dev.vars.production')) {
            if (Test-Path -LiteralPath ([IO.Path]::Combine($cursor, $name))) { Fail }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Invoke-PinnedCli([string[]]$Arguments, [byte[]]$InputBytes, [bool]$Quiet) {
    # Recheck locked entry bytes before every CLI call; no shell or PATH lookup.
    Assert-Hash $entryLock $WranglerEntrySha256
    Assert-Hash $nodeLock $NodeSha256
    $childEnvironment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in @('SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA')) {
        $value = [Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process)
        if ($value) { $childEnvironment.Add($name, $value) }
    }
    $childEnvironment.Add('CLOUDFLARE_ACCOUNT_ID', $accountId)
    $childEnvironment.Add('CI', 'true')
    $childEnvironment.Add('BROWSER', 'none')
    $childEnvironment.Add('NO_COLOR', '1')
    $childEnvironment.Add('WRANGLER_SEND_METRICS', 'false')
    $childEnvironment.Add('WRANGLER_WRITE_LOGS', 'false')
    $childEnvironment.Add('WRANGLER_LOG_SANITIZE', 'true')
    $childEnvironment.Add('WRANGLER_LOG', $(if ($Quiet) { 'none' } else { 'log' }))
    $childEnvironment.Add('TEMP', $temporary)
    $childEnvironment.Add('TMP', $temporary)
    $childEnvironment.Add('XDG_CONFIG_HOME', $configDirectory)
    $childEnvironment.Add('XDG_CACHE_HOME', $cacheDirectory)
    $argsList = [Collections.Generic.List[string]]::new()
    $argsList.Add($entry)
    foreach ($argument in $Arguments) { $argsList.Add($argument) }
    return [UmbraCloudflarePipe]::Run($node, $argsList.ToArray(), $temporary, $childEnvironment, $InputBytes, 45000, 262144)
}

try {
    if (-not $IsWindows -or ($Command -eq 'push' -and -not $ConfirmProductionKeyWrite) -or ($Command -eq 'preflight' -and $ConfirmProductionKeyWrite)) { Fail }
    $stage = [CloudflareTransferStage]::paths
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $state = Assert-PlainPath $StateDirectory $true
    $working = Assert-PlainPath $WorkingDirectory $true
    $configDirectory = Assert-PlainPath $WranglerConfigDirectory $true
    $cacheDirectory = Assert-PlainPath $WranglerCacheDirectory $true
    foreach ($directory in @($working, $configDirectory, $cacheDirectory)) { if ([IO.Path]::GetPathRoot($directory) -ine 'D:\') { Fail } }
    Assert-CleanParents $working
    $node = Assert-PlainPath $NodePath $false
    $entry = Assert-PlainPath $WranglerEntry $false
    if ([IO.Path]::GetFileName($node) -ine 'node.exe' -or [IO.Path]::GetFileName($entry) -cne 'cli.js' -or [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($entry)) -cne 'wrangler-dist') { Fail }
    if ([IO.Path]::GetPathRoot($entry) -ine 'D:\' -or $WranglerVersion -cne $reviewedWranglerVersion -or $WranglerEntrySha256 -cne $reviewedWranglerEntrySha256) { Fail }
    $stage = [CloudflareTransferStage]::tool_pins
    $nodeLock = [IO.FileStream]::new($node, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $entryLock = [IO.FileStream]::new($entry, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    Assert-Hash $nodeLock $NodeSha256
    Assert-Hash $entryLock $WranglerEntrySha256
    $packagePath = Assert-PlainPath ([IO.Path]::Combine([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($entry)), 'package.json')) $false
    $packageStream = [IO.FileStream]::new($packagePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { $packageBytes = Read-LockedBytes $packageStream 65536 } finally { $packageStream.Dispose() }
    $package = ConvertFrom-Json -InputObject ($utf8.GetString($packageBytes)) -AsHashtable
    if ($package['name'] -cne 'wrangler' -or $package['version'] -cne $WranglerVersion) { Fail }

    Add-Type -AssemblyName System.Security.Cryptography.ProtectedData
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
public sealed class UmbraCloudflareResult : IDisposable {
    public int ExitCode;
    public byte[] Output;
    public byte[] Error;
    public void Dispose() { if (Output != null) Array.Clear(Output, 0, Output.Length); if (Error != null) Array.Clear(Error, 0, Error.Length); }
}
public static class UmbraCloudflarePipe {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CreateDirectory(string path, IntPtr securityAttributes);
    public static byte[] Json(byte[] value) {
        if (value == null || value.Length < 1 || value.Length > 16384) throw new InvalidOperationException();
        new UTF8Encoding(false, true).GetCharCount(value);
        using var stream = new MemoryStream();
        try {
            using (var writer = new Utf8JsonWriter(stream)) {
                writer.WriteStartObject();
                writer.WriteString("APP_ENCRYPTION_KEY", value.AsSpan());
                writer.WriteEndObject();
            }
            return stream.ToArray();
        } finally { Array.Clear(stream.GetBuffer(), 0, (int)stream.Length); }
    }
    public static void ValidateJson(byte[] value) {
        using var document = JsonDocument.Parse(value, new JsonDocumentOptions { MaxDepth = 16 });
        Check(document.RootElement);
    }
    private static void Check(JsonElement element) {
        if (element.ValueKind == JsonValueKind.Object) {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject()) { if (!names.Add(property.Name)) throw new InvalidOperationException(); Check(property.Value); }
        } else if (element.ValueKind == JsonValueKind.Array) foreach (var item in element.EnumerateArray()) Check(item);
    }
    private static async Task<byte[]> ReadBounded(Stream input, int maximum) {
        byte[] buffer = new byte[4096];
        using var output = new MemoryStream();
        try {
            int count;
            while ((count = await input.ReadAsync(buffer.AsMemory(0, buffer.Length))) > 0) {
                if (output.Length + count > maximum) throw new InvalidOperationException();
                output.Write(buffer, 0, count);
            }
            return output.ToArray();
        } finally { Array.Clear(buffer, 0, buffer.Length); Array.Clear(output.GetBuffer(), 0, (int)output.Length); }
    }
    private static void ClearCompletedOrLater(Task<byte[]> task) {
        if (task == null) return;
        _ = task.ContinueWith(t => {
            if (t.IsCompletedSuccessfully) Array.Clear(t.Result, 0, t.Result.Length);
            else { var observed = t.Exception; }
        }, TaskContinuationOptions.ExecuteSynchronously);
    }
    public static UmbraCloudflareResult Run(string executable, string[] arguments, string directory, Dictionary<string,string> environment, byte[] input, int timeout, int maximum) {
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        info.Environment.Clear();
        foreach (var entry in environment) info.Environment.Add(entry.Key, entry.Value);
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        using var process = new Process { StartInfo = info };
        Task<byte[]> stdout = null, stderr = null;
        bool transferred = false;
        try {
            if (!process.Start()) throw new InvalidOperationException();
            stdout = ReadBounded(process.StandardOutput.BaseStream, maximum);
            stderr = ReadBounded(process.StandardError.BaseStream, maximum);
            var writer = Task.Run(async () => { try { if (input != null) await process.StandardInput.BaseStream.WriteAsync(input.AsMemory()); } finally { process.StandardInput.Close(); } });
            var finished = Task.WhenAll(stdout, stderr, writer, process.WaitForExitAsync());
            if (!finished.Wait(timeout)) throw new TimeoutException();
            var result = new UmbraCloudflareResult { ExitCode = process.ExitCode, Output = stdout.Result, Error = stderr.Result };
            transferred = true;
            return result;
        } finally {
            try { if (!process.HasExited) { process.Kill(true); process.WaitForExit(5000); } } catch { }
            if (!transferred) {
                ClearCompletedOrLater(stdout);
                ClearCompletedOrLater(stderr);
            }
        }
    }
}
'@
    $temporary = [IO.Path]::Combine($working, 'umbra-cloudflare-' + [Guid]::NewGuid().ToString('N'))
    New-ProtectedDirectory $temporary
    $stage = [CloudflareTransferStage]::cli_version
    $lastResult = Invoke-PinnedCli @('--version') $null $false
    if ($lastResult.ExitCode -ne 0 -or $utf8.GetString($lastResult.Output).Trim() -cne $WranglerVersion) { Fail }
    $lastResult.Dispose(); $lastResult = $null
    $stage = [CloudflareTransferStage]::cli_identity
    $lastResult = Invoke-PinnedCli @('whoami', '--json') $null $false
    if ($lastResult.ExitCode -ne 0) { Fail }
    [UmbraCloudflarePipe]::ValidateJson($lastResult.Output)
    $identity = ConvertFrom-Json -InputObject ($utf8.GetString($lastResult.Output)) -AsHashtable
    if ($identity['loggedIn'] -isnot [bool] -or -not $identity['loggedIn'] -or $identity['accounts'] -isnot [array]) { Fail }
    $accounts = @($identity['accounts'] | Where-Object { $_ -is [Collections.IDictionary] -and $_['id'] -ceq $accountId })
    if ($accounts.Count -ne 1) { Fail }
    $identity = $null
    $lastResult.Dispose(); $lastResult = $null
    $stage = [CloudflareTransferStage]::cli_project
    $lastResult = Invoke-PinnedCli @('pages', 'project', 'list', '--json') $null $false
    if ($lastResult.ExitCode -ne 0) { Fail }
    [UmbraCloudflarePipe]::ValidateJson($lastResult.Output)
    $projects = ConvertFrom-Json -InputObject ($utf8.GetString($lastResult.Output)) -AsHashtable -NoEnumerate
    if ($projects -isnot [array]) { Fail }
    $selected = @($projects | Where-Object { $_ -is [Collections.IDictionary] -and $_['Project Name'] -ceq $projectName })
    if ($selected.Count -ne 1 -or $selected[0]['Project Domains'] -isnot [string] -or 'proxy-pals-hub.pages.dev' -cnotin @($selected[0]['Project Domains'].Split(',') | ForEach-Object { $_.Trim() })) { Fail }
    $projects = $null; $selected = $null
    $lastResult.Dispose(); $lastResult = $null
    if ($Command -eq 'preflight') {
        [Console]::WriteLine('Cloudflare account/project and pinned CLI preflight passed. No key decrypted or remote secret changed.')
    } else {
        $stage = [CloudflareTransferStage]::vault_validate
        Assert-VaultAcl $state
        $secretPath = Assert-PlainPath ([IO.Path]::Combine($state, 'app-key.dpapi')) $false
        Assert-VaultAcl $secretPath
        $secretStream = [IO.FileStream]::new($secretPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try { $protectedSecret = Read-LockedBytes $secretStream 32768 } finally { $secretStream.Dispose() }
        $stage = [CloudflareTransferStage]::vault_unprotect
        $rawSecret = [Security.Cryptography.ProtectedData]::Unprotect($protectedSecret, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $stage = [CloudflareTransferStage]::json_encode
        $jsonBytes = [UmbraCloudflarePipe]::Json($rawSecret)
        $stage = [CloudflareTransferStage]::production_write
        $lastResult = Invoke-PinnedCli @('pages', 'secret', 'bulk', '--project-name', $projectName, '--env', $environmentName) $jsonBytes $true
        if ($lastResult.ExitCode -ne 0) { Fail }
        [Console]::WriteLine('Pinned Cloudflare production secret write completed. Database/session migration and runtime key verification are still separate steps.')
    }
    exit 0
} catch {
    # No exception text, child stdout/stderr, path, SID, token or payload escapes.
    # After a timeout/API failure, a write may already have committed: do not
    # claim rollback and do not retry automatically.
    [Console]::Error.WriteLine('Cloudflare key transfer stopped. No secret was printed; remote write state may need verification. [stage=' + $stage.ToString() + ']')
    exit 1
} finally {
    if ($lastResult) { $lastResult.Dispose() }
    foreach ($bytes in @($rawSecret, $jsonBytes, $protectedSecret)) { if ($bytes -is [byte[]]) { [Array]::Clear($bytes, 0, $bytes.Length) } }
    if ($nodeLock) { $nodeLock.Dispose() }
    if ($entryLock) { $entryLock.Dispose() }
    # Dedicated D: working data/cache contains no deliberately written secrets.
    # Keep it for inspection; never recursively delete arbitrary caller paths.
}
