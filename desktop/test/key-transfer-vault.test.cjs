const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../../scripts/key-transfer-vault.ps1');
const available = process.platform === 'win32' && spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'if ($PSVersionTable.PSVersion -lt [version]"7.4") { exit 1 }'], { windowsHide: true }).status === 0;
if (process.env.UMBRA_REQUIRE_DPAPI === '1' && !available) throw new Error('Native key transfer test requires Windows and PowerShell 7.4+');
const options = { skip: available ? false : 'Windows with PowerShell 7.4+ required' };
const synthetic = '  synthetic-key-not-real-☃\r\n\t';

function run(command, state, envelope) {
  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-Command', command, '-StateDirectory', state, ...(envelope ? ['-EnvelopePath', envelope] : [])], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

function assertRestrictedAcls(paths) {
  // Emit only aggregate booleans. SID, account names and paths never enter a
  // test failure message. In particular, file ownership must not silently
  // default to Administrators on an elevated Windows runner.
  const check = '$ErrorActionPreference="Stop"; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $paths=ConvertFrom-Json ([Console]::In.ReadToEnd()); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach($p in $paths){ $a=Get-Acl -LiteralPath $p; $rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if(-not $a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid -or $rules.Count -ne 2){exit 1}; foreach($r in $rules){if($r.IdentityReference.Value -notin @($sid,"S-1-5-18") -or $r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $r.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl){exit 1}}}; [Console]::Write("True")';
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8', windowsHide: true, input: JSON.stringify(paths), timeout: 30000 });
  assert.equal(result.status, 0, 'Vault owner or two-principal protected ACL did not match');
  assert.equal(result.stdout, 'True');
  assert.equal(result.stderr, '');
}

function prepare(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'umbra-key-transfer-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = path.join(directory, 'vault');
  const result = run('prepare', state);
  assert.equal(result.status, 0, result.stderr);
  assert(!result.stdout.includes(synthetic));
  const manifest = JSON.parse(fs.readFileSync(path.join(state, 'public-manifest.json'), 'utf8'));
  return { directory, state, manifest };
}

function proof(secret, plain = 'synthetic canary; not a user record') {
  const key = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { plain, encrypted: [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64')).join('.') };
}

function envelope(manifest, changes = {}, payloadChanges = {}) {
  const value = {
    format: 'umbra-key-transfer-v1', transferId: manifest.transferId,
    keyId: manifest.keyId, sourceOrigin: manifest.sourceOrigin,
    targetOrigin: manifest.targetOrigin, issuedAt: new Date().toISOString(),
    expiresAt: manifest.expiresAt, ...changes,
  };
  const aad = Buffer.from(JSON.stringify(['format', 'transferId', 'keyId', 'sourceOrigin', 'targetOrigin', 'issuedAt', 'expiresAt'].map(key => value[key])));
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const payload = { secretName: 'APP_ENCRYPTION_KEY', secret: synthetic, canary: proof(synthetic), ...payloadChanges };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const wrapped = crypto.publicEncrypt({ key: Buffer.from(manifest.publicKeySpki, 'base64'), format: 'der', type: 'spki', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { ...value, wrappedKey: wrapped.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function receiveFixture(fixture, value) {
  const envelopePath = path.join(fixture.directory, `envelope-${crypto.randomUUID()}.json`);
  fs.writeFileSync(envelopePath, typeof value === 'string' ? value : JSON.stringify(value));
  return { result: run('receive', fixture.state, envelopePath), envelopePath };
}

function rejected(fixture, value) {
  const { result } = receiveFixture(fixture, value);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Key transfer failed safely\./);
  assert(!result.stderr.includes(synthetic));
  assert(!fs.existsSync(path.join(fixture.state, 'app-key.dpapi')));
}

test('vault prepares only public metadata and a DPAPI private key with restricted ACL', options, t => {
  const { state, manifest } = prepare(t);
  assert.equal(manifest.format, 'umbra-key-transfer-request-v1');
  assert.equal(manifest.sourceOrigin, 'https://proxy-pals-hub.lovable.app');
  assert.equal(manifest.targetOrigin, 'https://umbra.mafiatrafa.com');
  assert.equal(manifest.keyId, crypto.createHash('sha256').update(Buffer.from(manifest.publicKeySpki, 'base64')).digest('hex'));
  assert.equal(Date.parse(manifest.expiresAt) - Date.parse(manifest.createdAt), 30 * 60 * 1000);
  assert.deepEqual(fs.readdirSync(state).sort(), ['private.dpapi', 'public-manifest.json']);
  const privateData = fs.readFileSync(path.join(state, 'private.dpapi'));
  assert(!privateData.includes(Buffer.from('PRIVATE KEY')));
  assert(!privateData.includes(Buffer.from(synthetic)));
  const again = run('prepare', state);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /\[stage=state_directory_create\]\s*$/);
  assert.equal(fs.readFileSync(path.join(state, 'private.dpapi')).equals(privateData), true);
  assertRestrictedAcls([state, path.join(state, 'private.dpapi'), path.join(state, 'public-manifest.json')]);
});

test('vault receives a Node RSA-OAEP SHA256 / AES-GCM envelope without normalizing the raw key', options, t => {
  const fixture = prepare(t);
  const { result, envelopePath } = receiveFixture(fixture, envelope(fixture.manifest));
  assert.equal(result.status, 0, result.stderr);
  assert(!result.stdout.includes(synthetic));
  assert(!result.stderr.includes(synthetic));
  const protectedData = fs.readFileSync(path.join(fixture.state, 'app-key.dpapi'));
  assert(!protectedData.includes(Buffer.from(synthetic)));
  assertRestrictedAcls([path.join(fixture.state, 'app-key.dpapi')]);
  // This synthetic-only check decrypts in memory and emits a boolean, never the
  // plaintext or private key. The production tool has no decrypt/export command.
  const verify = '$ErrorActionPreference="Stop"; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security.Cryptography.ProtectedData; $j=ConvertFrom-Json ([Console]::In.ReadToEnd()); $b=[IO.File]::ReadAllBytes($j.path); $e=[Text.Encoding]::UTF8.GetBytes("Umbra key transfer vault v1"); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); $expected=[Text.Encoding]::UTF8.GetBytes($j.expected); [Console]::Write([Security.Cryptography.CryptographicOperations]::FixedTimeEquals($p,$expected)); [Array]::Clear($p,0,$p.Length)';
  const verified = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', verify], { encoding: 'utf8', windowsHide: true, input: JSON.stringify({ path: path.join(fixture.state, 'app-key.dpapi'), expected: synthetic }) });
  assert.equal(verified.status, 0);
  assert.equal(verified.stdout, 'True');
  assert.equal(verified.stderr, '');
  const replay = run('receive', fixture.state, envelopePath);
  assert.equal(replay.status, 1);
  assert.match(replay.stderr, /\[stage=state_validate\]\s*$/);
  assert(fs.readFileSync(path.join(fixture.state, 'app-key.dpapi')).equals(protectedData));
});

test('vault rejects unknown/duplicate fields, wrong pins, expired envelopes, invalid algorithms and canaries', options, t => {
  const fixture = prepare(t);
  const valid = envelope(fixture.manifest);
  for (const changes of [
    { format: 'other' }, { transferId: crypto.randomUUID() }, { keyId: '0'.repeat(64) },
    { sourceOrigin: 'https://attacker.invalid' }, { targetOrigin: 'https://attacker.invalid' },
    { expiresAt: new Date(Date.now() - 1000).toISOString() },
    { issuedAt: new Date(Date.now() + 120000).toISOString() },
  ]) rejected(fixture, envelope(fixture.manifest, changes));
  rejected(fixture, { ...valid, extra: true });
  rejected(fixture, JSON.stringify(valid).replace('"format":', '"format":"duplicate", "format":'));
  rejected(fixture, { ...valid, iv: Buffer.alloc(11).toString('base64') });
  rejected(fixture, { ...valid, tag: Buffer.alloc(16).toString('base64') });
  rejected(fixture, { ...valid, wrappedKey: Buffer.alloc(384).toString('base64') });
  rejected(fixture, envelope(fixture.manifest, {}, { secretName: 'OTHER_KEY' }));
  rejected(fixture, envelope(fixture.manifest, {}, { secret: '' }));
  rejected(fixture, envelope(fixture.manifest, {}, { canary: proof('wrong-synthetic-key') }));
  const failedProof = proof(synthetic); failedProof.plain += 'changed';
  rejected(fixture, envelope(fixture.manifest, {}, { canary: failedProof }));
});

test('vault rejects state and envelope junctions instead of following them', options, t => {
  const fixture = prepare(t);
  const junction = path.join(fixture.directory, 'linked-state');
  fs.symlinkSync(fixture.state, junction, 'junction');
  assert.equal(run('prepare', junction).status, 1);
  const value = envelope(fixture.manifest);
  const file = path.join(fixture.directory, 'source-envelope.json');
  fs.writeFileSync(file, JSON.stringify(value));
  const linkedParent = path.join(fixture.directory, 'linked-parent');
  fs.symlinkSync(fixture.directory, linkedParent, 'junction');
  assert.equal(run('receive', fixture.state, path.join(linkedParent, 'source-envelope.json')).status, 1);
  assert(!fs.existsSync(path.join(fixture.state, 'app-key.dpapi')));
});

test('vault stage diagnostics reveal only fixed enum labels and reject inherited ACLs', options, t => {
  const fixture = prepare(t);
  // Replace only a disposable synthetic fixture with a newly created file.
  // NTFS gives it inherited (not protected) access rules without requiring
  // SeSecurityPrivilege or changing the machine/user security configuration.
  const privatePath = path.join(fixture.state, 'private.dpapi');
  const bytes = fs.readFileSync(privatePath);
  fs.renameSync(privatePath, path.join(fixture.state, 'synthetic-private-backup.dpapi'));
  fs.writeFileSync(privatePath, bytes, { flag: 'wx' });
  const { result } = receiveFixture(fixture, envelope(fixture.manifest));
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Key transfer failed safely. No secret was printed or remotely changed. [stage=state_validate]');
  assert(!fs.existsSync(path.join(fixture.state, 'app-key.dpapi')));
});
