const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

const MAX_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

// A CRX file is a small header followed by a plain ZIP archive.
function stripCrxHeader(buffer) {
  if (buffer.length < 16 || buffer.toString("latin1", 0, 4) !== "Cr24") return buffer;
  const version = buffer.readUInt32LE(4);
  if (version === 2) {
    const publicKey = buffer.readUInt32LE(8);
    const signature = buffer.readUInt32LE(12);
    const offset = 16 + publicKey + signature;
    if (offset >= buffer.length) throw new Error("Файл расширения повреждён");
    return buffer.subarray(offset);
  }
  if (version === 3) {
    const headerLength = buffer.readUInt32LE(8);
    const offset = 12 + headerLength;
    if (offset >= buffer.length) throw new Error("Файл расширения повреждён");
    return buffer.subarray(offset);
  }
  throw new Error("Неподдерживаемый формат файла расширения");
}

function findEndOfCentralDirectory(buffer) {
  const limit = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= limit; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("Архив расширения повреждён");
}

function readEntries(buffer) {
  const end = findEndOfCentralDirectory(buffer);
  const total = buffer.readUInt16LE(end + 10);
  if (total > MAX_ENTRIES) throw new Error("Расширение слишком большое");
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Архив расширения повреждён");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.push({ name, method, compressedSize, size, localOffset, mode: externalAttributes >>> 16 });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readData(buffer, entry) {
  const start = entry.localOffset;
  if (buffer.readUInt32LE(start) !== 0x04034b50) throw new Error("Архив расширения повреждён");
  const nameLength = buffer.readUInt16LE(start + 26);
  const extraLength = buffer.readUInt16LE(start + 28);
  const from = start + 30 + nameLength + extraLength;
  const raw = buffer.subarray(from, from + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_BYTES });
  throw new Error("Неподдерживаемое сжатие в архиве расширения");
}

function safeJoin(root, name) {
  if (name.includes("\0") || name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) {
    throw new Error("Архив расширения содержит небезопасные пути");
  }
  const target = path.resolve(root, name);
  const base = path.resolve(root);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("Архив расширения содержит небезопасные пути");
  }
  return target;
}

async function unpackArchive(input, destination) {
  const buffer = stripCrxHeader(Buffer.isBuffer(input) ? input : Buffer.from(input));
  if (buffer.length > MAX_BYTES) throw new Error("Расширение слишком большое");
  const entries = readEntries(buffer);
  let written = 0;
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    // A symlink entry (mode 0xA000) is never restored as a link.
    if ((entry.mode & 0xf000) === 0xa000) throw new Error("Символические ссылки в расширениях не поддерживаются");
    const target = safeJoin(destination, entry.name);
    if (entry.name.endsWith("/")) { await fs.mkdir(target, { recursive: true }); continue; }
    written += entry.size;
    if (written > MAX_BYTES) throw new Error("Расширение слишком большое");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, readData(buffer, entry));
  }
  return destination;
}

module.exports = { stripCrxHeader, unpackArchive, safeJoin };
