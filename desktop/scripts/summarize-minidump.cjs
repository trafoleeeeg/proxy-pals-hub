const fs = require("node:fs");
const path = require("node:path");

// Deliberately inspect only the directory, exception record and module table.
// Never read memory streams, environment, command line or session annotations.
function summarizeMinidump(file) {
  const fd = fs.openSync(file, "r");
  const size = fs.fstatSync(fd).size;
  const read = (at, bytes) => {
    if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1024 * 1024 || at + bytes > size) throw new Error("Invalid minidump metadata range");
    const buffer = Buffer.alloc(bytes);
    if (fs.readSync(fd, buffer, 0, bytes, at) !== bytes) throw new Error("Truncated minidump metadata");
    return buffer;
  };
  try {
    const header = read(0, 32);
    if (header.toString("ascii", 0, 4) !== "MDMP") throw new Error("Not a minidump");
    const count = header.readUInt32LE(8);
    if (count > 128) throw new Error("Too many minidump streams");
    const directory = read(header.readUInt32LE(12), count * 12);
    const streams = new Map();
    for (let i = 0; i < count; i++) streams.set(directory.readUInt32LE(i * 12), {
      size: directory.readUInt32LE(i * 12 + 4), at: directory.readUInt32LE(i * 12 + 8),
    });
    const exception = streams.get(6);
    if (!exception || exception.size < 40) throw new Error("Missing exception metadata");
    const record = read(exception.at, 40);
    const address = record.readBigUInt64LE(24);
    const result = { timeUtc: new Date(header.readUInt32LE(20) * 1000).toISOString(),
      threadId: record.readUInt32LE(0), exceptionCode: "0x" + record.readUInt32LE(8).toString(16).padStart(8, "0"),
      exceptionAddress: "0x" + address.toString(16), module: null };
    const moduleStream = streams.get(4);
    if (moduleStream?.size >= 4) {
      const modules = read(moduleStream.at, 4).readUInt32LE(0);
      if (modules > 2048 || 4 + modules * 108 > moduleStream.size) throw new Error("Invalid module metadata");
      const table = read(moduleStream.at + 4, modules * 108);
      for (let i = 0; i < modules; i++) {
        const p = i * 108, base = table.readBigUInt64LE(p), imageSize = table.readUInt32LE(p + 8);
        if (address < base || address >= base + BigInt(imageSize)) continue;
        const nameAt = table.readUInt32LE(p + 20), nameSize = read(nameAt, 4).readUInt32LE(0);
        if (nameSize > 2048 || nameSize % 2) throw new Error("Invalid module name metadata");
        const name = path.win32.basename(read(nameAt + 4, nameSize).toString("utf16le"));
        result.module = { name: /^[a-zA-Z0-9_. -]{1,128}$/.test(name) ? name : "unrecognized-module",
          offset: "0x" + (address - base).toString(16), timestamp: table.readUInt32LE(p + 16) };
        const cvSize = table.readUInt32LE(p + 76), cvAt = table.readUInt32LE(p + 80);
        if (cvSize >= 24) {
          const cv = read(cvAt, 24);
          if (cv.toString("ascii", 0, 4) === "RSDS") {
            result.module.pdbGuidBytes = cv.subarray(4, 20).toString("hex");
            result.module.pdbAge = cv.readUInt32LE(20);
          }
        }
        break;
      }
    }
    return result;
  } finally { fs.closeSync(fd); }
}
if (require.main === module) {
  try { console.log(JSON.stringify(summarizeMinidump(process.argv[2]))); }
  catch { console.error("Minidump metadata could not be summarized"); process.exitCode = 1; }
}
module.exports = { summarizeMinidump };
