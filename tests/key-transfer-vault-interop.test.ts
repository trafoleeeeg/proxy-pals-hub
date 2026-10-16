import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptSecret } from "../src/lib/crypto.server";
import { sealKeyTransfer, type KeyTransferRequest } from "../src/lib/key-transfer.server";

const supported = process.platform === "win32" && spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "if ($PSVersionTable.PSVersion -lt [version]'7.4') { exit 1 }"], { windowsHide: true }).status === 0;
if (process.env["UMBRA_REQUIRE_DPAPI"] === "1" && !supported) throw new Error("Native key transfer test requires Windows and PowerShell 7.4+");
const script = fileURLToPath(new URL("../scripts/key-transfer-vault.ps1", import.meta.url));

test.skipIf(!supported)("actual TS seal and existing encryptSecret are interoperable with Windows DPAPI receive", () => {
  const parent = resolve(mkdtempSync(join(tmpdir(), "umbra-ts-vault-")));
  const vault = join(parent, "vault");
  const previous = process.env["APP_ENCRYPTION_KEY"];
  const synthetic = "  SYNTHETIC_TS_TO_POWERSHELL_ключ🙂\r\n\t";
  try {
    const prepared = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, "-Command", "prepare", "-StateDirectory", vault], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    expect(prepared.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(vault, "public-manifest.json"), "utf8")) as KeyTransferRequest;
    process.env["APP_ENCRYPTION_KEY"] = synthetic;
    const plain = "synthetic-canary-not-a-user-record";
    const envelope = sealKeyTransfer(synthetic, { plain, encrypted: encryptSecret(plain) }, manifest, Date.now());
    const file = join(parent, "encrypted-envelope.json");
    writeFileSync(file, JSON.stringify(envelope));
    const received = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, "-Command", "receive", "-StateDirectory", vault, "-EnvelopePath", file], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    expect(received.status).toBe(0);
    expect(received.stdout + received.stderr).not.toContain(synthetic);
    const stored = readFileSync(join(vault, "app-key.dpapi"));
    expect(stored.includes(Buffer.from(synthetic, "utf8"))).toBe(false);
    const check = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security.Cryptography.ProtectedData; $j=ConvertFrom-Json ([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($j.path),[Text.Encoding]::UTF8.GetBytes('Umbra key transfer vault v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser); try { [Console]::Write([Security.Cryptography.CryptographicOperations]::FixedTimeEquals($p,[Text.Encoding]::UTF8.GetBytes($j.expected))) } finally { [Array]::Clear($p,0,$p.Length) }";
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", check], { encoding: "utf8", windowsHide: true, input: JSON.stringify({ path: join(vault, "app-key.dpapi"), expected: synthetic }), timeout: 30000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("True");
    expect(result.stderr).toBe("");
  } finally {
    if (previous === undefined) delete process.env["APP_ENCRYPTION_KEY"]; else process.env["APP_ENCRYPTION_KEY"] = previous;
    // Delete only this exact synthetic test fixture, never a computed broad path.
    const child = relative(resolve(tmpdir()), parent);
    if (!child || child.startsWith("..") || isAbsolute(child) || !basename(parent).startsWith("umbra-ts-vault-")) throw new Error("Unsafe synthetic fixture cleanup target");
    rmSync(parent, { recursive: true, force: true });
  }
}, 120000);
