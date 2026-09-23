// Build same-origin country tables from the PDDL-licensed @iplookup/country data.
// No proxy IP or credential is sent to the package publisher at runtime.
const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

const packageDir = dirname(require.resolve("@iplookup/country"));
const outputDir = resolve(__dirname, "../public/geoip");

function pack(version) {
  const ipBytes = version === 4 ? 4 : 8;
  const recordBytes = ipBytes * 2 + 2;
  const index = readFileSync(join(packageDir, `${version}.idx`));
  if (index.length % ipBytes !== 0) throw new Error(`Invalid IPv${version} index`);
  const chunks = [];
  let previousStart = -1n;

  for (let i = 0; i < index.length / ipBytes; i++) {
    const name = i.toString(36).padStart(2, "_");
    const source = readFileSync(join(packageDir, String(version), name));
    if (source.length % recordBytes !== 0) throw new Error(`Invalid IPv${version} chunk ${name}`);
    const count = source.length / recordBytes;
    const packed = Buffer.allocUnsafe(source.length);
    for (let j = 0; j < count; j++) {
      const startOffset = j * ipBytes;
      const endOffset = (count + j) * ipBytes;
      const countryOffset = count * ipBytes * 2 + j * 2;
      const start = ipBytes === 4 ? BigInt(source.readUInt32LE(startOffset)) : source.readBigUInt64LE(startOffset);
      const end = ipBytes === 4 ? BigInt(source.readUInt32LE(endOffset)) : source.readBigUInt64LE(endOffset);
      // IPv6 data may contain multiple ranges with the same first 64 bits.
      if (start < previousStart || end < start) throw new Error(`Unsorted IPv${version} country data at ${name}/${j}`);
      previousStart = start;
      source.copy(packed, j * recordBytes, startOffset, startOffset + ipBytes);
      source.copy(packed, j * recordBytes + ipBytes, endOffset, endOffset + ipBytes);
      source.copy(packed, j * recordBytes + ipBytes * 2, countryOffset, countryOffset + 2);
    }
    chunks.push(packed);
  }

  mkdirSync(outputDir, { recursive: true });
  const output = join(outputDir, `ipv${version}.bin`);
  writeFileSync(output, Buffer.concat(chunks));
  process.stdout.write(`Generated IPv${version} country table\n`);
}

pack(4);
pack(6);

