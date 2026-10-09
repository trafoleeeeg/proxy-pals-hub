const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { summarizeMinidump } = require("../scripts/summarize-minidump.cjs");

test("minidump summary reads exception metadata, never private memory streams", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-dump-metadata-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buffer = Buffer.alloc(256);
  buffer.write("MDMP");
  buffer.writeUInt32LE(2, 8); buffer.writeUInt32LE(32, 12); buffer.writeUInt32LE(1700000000, 20);
  buffer.writeUInt32LE(6, 32); buffer.writeUInt32LE(40, 36); buffer.writeUInt32LE(64, 40);
  buffer.writeUInt32LE(5, 44); buffer.writeUInt32LE(128, 48); buffer.writeUInt32LE(128, 52);
  buffer.writeUInt32LE(123, 64); buffer.writeUInt32LE(0x80000003, 72); buffer.writeBigUInt64LE(0x1234n, 88);
  buffer.write("secret-cookie-token-https://private.example", 128);
  const file = path.join(root, "synthetic.dmp"); fs.writeFileSync(file, buffer);
  const summary = summarizeMinidump(file);
  assert.equal(summary.exceptionCode, "0x80000003");
  assert.equal(summary.exceptionAddress, "0x1234");
  assert.doesNotMatch(JSON.stringify(summary), /private|cookie|token|secret/);
  buffer.writeUInt32LE(129, 8); fs.writeFileSync(file, buffer);
  assert.throws(() => summarizeMinidump(file), /Too many/);
});
