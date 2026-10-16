// Lightweight contract checks only: no CLI execution, native key generation,
// installation, account access, DPAPI Unprotect or network requests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const normalizeLineEndings = value => value.replace(/\r\n/g, '\n');
const source = normalizeLineEndings(fs.readFileSync(path.resolve(__dirname, '../../scripts/key-transfer-cloudflare.ps1'), 'utf8'));

test('security source contracts see identical text from LF and Windows CRLF checkouts', () => {
  assert.equal(normalizeLineEndings(source), source);
  assert.equal(normalizeLineEndings(source.replace(/\n/g, '\r\n')), source);
});

test('Cloudflare destination and reviewed Wrangler entry are not caller-selectable', () => {
  assert.match(source, /\$accountId = '783398cd847a9aa13275dfab6ab2df2c'/);
  assert.match(source, /\$projectName = 'proxy-pals-hub'/);
  assert.match(source, /\$environmentName = 'production'/);
  assert.match(source, /\$reviewedWranglerVersion = '4\.151\.1'/);
  assert.match(source, /\$reviewedWranglerEntrySha256 = 'a1b3cf7023a53d0d7f7ca4a183f2f904573cdb00737cd1a034890207431f1d8e'/);
  assert.match(source, /\$WranglerVersion -cne \$reviewedWranglerVersion/);
  assert.match(source, /\$WranglerEntrySha256 -cne \$reviewedWranglerEntrySha256/);
});

test('default is preflight and explicit push approval precedes paths and Unprotect', () => {
  assert.match(source, /\$Command = 'preflight'/);
  const approval = source.indexOf("$Command -eq 'push' -and -not $ConfirmProductionKeyWrite");
  const paths = source.indexOf('$stage = [CloudflareTransferStage]::paths');
  const unprotect = source.indexOf('[Security.Cryptography.ProtectedData]::Unprotect(');
  assert(approval >= 0 && approval < paths && paths < unprotect);
  assert(source.indexOf("if ($Command -eq 'preflight')") < unprotect);
});

test('version, authenticated account and project checks finish before DPAPI use', () => {
  const unprotect = source.indexOf('[Security.Cryptography.ProtectedData]::Unprotect(');
  for (const command of ["@('--version')", "@('whoami', '--json')", "@('pages', 'project', 'list', '--json')"]) {
    assert(source.indexOf(command) >= 0 && source.indexOf(command) < unprotect);
  }
  assert.match(source, /\$identity\['loggedIn'\]/);
  assert.match(source, /\$_\['id'\] -ceq \$accountId/);
  assert.match(source, /\$_\['Project Name'\] -ceq \$projectName/);
  assert.match(source, /'proxy-pals-hub\.pages\.dev'/);
});

test('raw key is JSON encoded from exact UTF-8 bytes and sent only through redirected stdin', () => {
  assert.match(source, /GetCharCount\(value\)/);
  assert.match(source, /writer\.WriteString\("APP_ENCRYPTION_KEY", value\.AsSpan\(\)\)/);
  assert.match(source, /process\.StandardInput\.BaseStream\.WriteAsync\(input\.AsMemory\(\)\)/);
  assert.match(source, /@\('pages', 'secret', 'bulk', '--project-name', \$projectName, '--env', \$environmentName\) \$jsonBytes \$true/);
  assert(!source.includes('GetString($rawSecret)'));
  assert(!/Set-Clipboard|Invoke-Expression|Start-Process|secret', 'put'|WriteAllBytes|WriteAllText|Set-Content/.test(source));
});

test('child environment removes inherited overrides and disables metrics/disk logs', () => {
  assert.match(source, /info\.Environment\.Clear\(\)/);
  assert.match(source, /UseShellExecute = false/);
  assert.match(source, /CreateNoWindow = true/);
  for (const [name, value] of [['CLOUDFLARE_ACCOUNT_ID', '$accountId'], ['WRANGLER_WRITE_LOGS', "'false'"], ['WRANGLER_SEND_METRICS', "'false'"], ['WRANGLER_LOG_SANITIZE', "'true'"]]) {
    assert(source.includes(`$childEnvironment.Add('${name}', ${value})`));
  }
  assert(!source.includes("$childEnvironment.Add('APP_ENCRYPTION_KEY'"));
  assert(!source.includes("$childEnvironment.Add('NODE_OPTIONS'"));
  assert.match(source, /\$childEnvironment\.Add\('XDG_CONFIG_HOME', \$configDirectory\)/);
  assert.match(source, /\$childEnvironment\.Add\('XDG_CACHE_HOME', \$cacheDirectory\)/);
});

test('DPAPI state enforces current owner, protected two-principal ACL and rejects reparses', () => {
  assert.match(source, /FileAttributes\]::ReparsePoint/);
  assert.match(source, /AreAccessRulesProtected/);
  assert.match(source, /GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)\.Value -ne \$currentSid\.Value/);
  assert.match(source, /\$rules\.Count -ne 2/);
  assert.match(source, /'S-1-5-18'/);
  assert.match(source, /DataProtectionScope\]::CurrentUser/);
  assert.match(source, /Assert-VaultAcl \$secretPath/);
});

test('subprocess has bounded pipes, timeout, process-tree termination and buffer clearing', () => {
  assert.match(source, /ReadBounded\(process\.StandardOutput\.BaseStream, maximum\)/);
  assert.match(source, /ReadBounded\(process\.StandardError\.BaseStream, maximum\)/);
  assert.match(source, /output\.Length \+ count > maximum/);
  assert.match(source, /finished\.Wait\(timeout\)/);
  assert.match(source, /process\.Kill\(true\)/);
  assert.match(source, /Array\]::Clear\(\$bytes, 0, \$bytes\.Length\)/);
  assert.match(source, /ClearCompletedOrLater\(stdout\)/);
});

test('only fixed stage diagnostics escape and failures do not claim rollback', () => {
  assert.match(source, /enum CloudflareTransferStage/);
  const start = source.indexOf('} catch {\n    # No exception text');
  const catchBlock = source.slice(start, source.indexOf('} finally {', start));
  assert(start > 0 && catchBlock.includes('$stage.ToString()'));
  assert(!/Exception|\$_|\.Output|\.Error/.test(catchBlock.replace('# No exception text', '')));
  assert.match(catchBlock, /remote write state may need verification/);
});

test('tiny offline C# checks preserve bytes, direct stdin, bounds, timeout and child exit status', {
  skip: process.platform === 'win32' ? false : 'PowerShell/.NET subprocess helper is Windows-only',
}, () => {
  // Compile ONLY the extracted C# transport, not the PowerShell entrypoint.
  // No Wrangler, account access, login, DPAPI or real secrets are involved.
  const csharp = /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/.exec(source)?.[1];
  assert(csharp, 'Expected one independently compilable transport class');
  const tempParent = 'D:/Codex/cache/tmp';
  fs.mkdirSync(tempParent, { recursive: true });
  assert.equal(path.parse(fs.realpathSync(tempParent)).root.toLowerCase(), 'd:\\');
  const testScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inputData = ConvertFrom-Json ([Console]::In.ReadToEnd())
$testRoot = $null
$phase = 'paths'
try {
  $parent = [IO.Path]::GetFullPath($inputData.temp)
  if ([IO.Path]::GetPathRoot($parent) -ine 'D:\' -or -not [IO.Directory]::Exists($parent)) { throw 'fixture' }
  $testRoot = [IO.Path]::Combine($parent, 'umbra-cf-pipe-test-' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($testRoot)
  $env:TEMP = $testRoot; $env:TMP = $testRoot
  $phase = 'compile'
  Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($inputData.source)))
  $phase = 'json'
  $raw = [Convert]::FromBase64String($inputData.synthetic)
  $json = [UmbraCloudflarePipe]::Json($raw)
  $document = [Text.Json.JsonDocument]::Parse([Text.Encoding]::UTF8.GetString($json))
  try {
    $roundTrip = [Text.Encoding]::UTF8.GetBytes($document.RootElement.GetProperty('APP_ENCRYPTION_KEY').GetString())
    if (-not [Security.Cryptography.CryptographicOperations]::FixedTimeEquals($raw, $roundTrip)) { throw 'fixture' }
  } finally { $document.Dispose(); [Array]::Clear($roundTrip, 0, $roundTrip.Length) }
  $childEnvironment = [Collections.Generic.Dictionary[string,string]]::new()
  $childEnvironment.Add('SystemRoot', [Environment]::GetEnvironmentVariable('SystemRoot'))
  $childEnvironment.Add('TEMP', $testRoot); $childEnvironment.Add('TMP', $testRoot)
  $code = 'let value="";process.stdin.on("data",chunk=>value+=chunk);process.stdin.on("end",()=>{const keys=Object.keys(JSON.parse(value));process.stdout.write(String(keys.length===1&&keys[0]==="APP_ENCRYPTION_KEY"&&process.argv[1]==="a & b"));});'
  $phase = 'pipe'
  $result = [UmbraCloudflarePipe]::Run($inputData.node, [string[]]@('-e',$code,'a & b'), $testRoot, $childEnvironment, $json, 5000, 1024)
  try { if ($result.ExitCode -ne 0 -or [Text.Encoding]::UTF8.GetString($result.Output) -cne 'true' -or $result.Error.Length -ne 0) { throw 'fixture' } } finally { $result.Dispose() }
  $phase = 'exit'
  $result = [UmbraCloudflarePipe]::Run($inputData.node, [string[]]@('-e','process.exitCode=7'), $testRoot, $childEnvironment, $null, 5000, 1024)
  try { if ($result.ExitCode -ne 7) { throw 'fixture' } } finally { $result.Dispose() }
  $phase = 'timeout'
  $timedOut = $false
  try { $result = [UmbraCloudflarePipe]::Run($inputData.node, [string[]]@('-e','setTimeout(()=>{},10000)'), $testRoot, $childEnvironment, $null, 100, 1024); $result.Dispose() } catch { $timedOut = $true }
  if (-not $timedOut) { throw 'fixture' }
  $phase = 'bounds'
  $bounded = $false
  try { $result = [UmbraCloudflarePipe]::Run($inputData.node, [string[]]@('-e','process.stdout.write("x".repeat(2048))'), $testRoot, $childEnvironment, $null, 5000, 64); $result.Dispose() } catch { $bounded = $true }
  if (-not $bounded) { throw 'fixture' }
  [Array]::Clear($raw, 0, $raw.Length); [Array]::Clear($json, 0, $json.Length)
  [Console]::Write('offline-pipe-ok')
} catch { [Console]::Error.Write('Offline C# transport check failed [stage=' + $phase + ']'); exit 1 }
finally {
  if ($testRoot) {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    if ([IO.Path]::GetDirectoryName($resolved) -ceq $parent -and [IO.Path]::GetFileName($resolved).StartsWith('umbra-cf-pipe-test-')) { Remove-Item -LiteralPath $resolved -Recurse -Force }
  }
}
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', testScript], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, TEMP: tempParent, TMP: tempParent },
    input: JSON.stringify({ source: Buffer.from(csharp).toString('base64'), node: process.execPath, temp: tempParent, synthetic: Buffer.from('  synthetic C# pipe — ключ🙂\r\n\t').toString('base64') }),
  });
  const phase = /\[stage=(paths|compile|json|pipe|exit|timeout|bounds)\]/.exec(result.stderr)?.[1] ?? 'unknown';
  assert.equal(result.status, 0, `Offline C# transport check failed (${phase}); no captured output is printed`);
  assert.equal(result.stdout, 'offline-pipe-ok');
  assert.equal(result.stderr, '');
});
