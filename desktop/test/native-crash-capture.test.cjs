const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateConsent, pruneDumps, startNativeCrashCapture } = require("../runtime/native-crash-capture.cjs");

test("native capture requires explicit short-lived local consent and a dedicated local path", () => {
  const now = Date.now();
  const valid = { enabled: true, expiresAt: now + 86400000, directory: "D:/private/umbra-native-crashes" };
  assert.ok(validateConsent(valid, now));
  for (const value of [null, {}, { ...valid, enabled: "true" }, { ...valid, expiresAt: now },
    { ...valid, expiresAt: now + 8 * 86400000 }]) assert.equal(validateConsent(value, now), null);
  for (const directory of ["D:/", "D:/umbra-native-crashes", "//server/share/umbra-native-crashes", "D:/private/../umbra-native-crashes",
    "D:/private/cookies", "D:/private/umbra-native-crashes:stream", "D:/private./umbra-native-crashes", "D:/private\0/umbra-native-crashes"])
    assert.equal(validateConsent({ ...valid, directory }, now), null);
});

test("absent consent and non-Windows runtime never initialize or upload reports", t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-capture-unit-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const electron = { app: { getPath: () => userData }, crashReporter: { start: () => assert.fail("must not start") } };
  assert.equal(startNativeCrashCapture(electron, "browser", { platform: "win32" }), false);
  assert.equal(startNativeCrashCapture(electron, "browser", { platform: "linux" }), false);
  fs.mkdirSync(path.join(userData, "diagnostics"));
  fs.writeFileSync(path.join(userData, "diagnostics/native-crash-capture.json"), JSON.stringify({ enabled: true, directory: "https://private.example" }));
  assert.equal(startNativeCrashCapture(electron, "browser", { platform: "win32" }), false);
  const log = fs.readFileSync(path.join(userData, "diagnostics/process-events.jsonl"), "utf8");
  assert.doesNotMatch(log, /private|https|directory/);
});

test("retention touches only closed UUID minidumps and keeps the newest three", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-capture-retention-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reports = path.join(directory, "reports");
  fs.mkdirSync(reports);
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    const file = path.join(reports, `00000000-0000-0000-0000-${String(i).padStart(12, "0")}.dmp`);
    fs.writeFileSync(file, "synthetic");
    fs.utimesSync(file, new Date(now - 300000 - i * 1000), new Date(now - 300000 - i * 1000));
  }
  fs.writeFileSync(path.join(reports, "settings.dat"), "keep");
  fs.writeFileSync(path.join(reports, "profile.dmp"), "keep");
  assert.equal(pruneDumps(directory, now), 2);
  assert.equal(fs.readdirSync(reports).filter(name => name.startsWith("00000000")).length, 3);
  assert.equal(fs.readFileSync(path.join(reports, "profile.dmp"), "utf8"), "keep");
  assert.equal(pruneDumps(directory, now), 0);
});
