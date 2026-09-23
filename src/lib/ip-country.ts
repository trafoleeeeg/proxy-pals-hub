/** Country lookup against static files served by Umbra. Proxy IPs never leave this app. */
type Version = 4 | 6;
type Address = { version: Version; value: number | bigint };
const tables = new Map<Version, Promise<DataView | null>>();

function ipv4Number(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((number, part) => number * 256 + Number(part), 0);
}

function parseAddress(value: string): Address | null {
  if (!value.includes(":")) {
    const number = ipv4Number(value);
    return number === null ? null : { version: 4, value: number };
  }

  let ipv6 = value.toLowerCase();
  if (ipv6.includes(".")) {
    const lastColon = ipv6.lastIndexOf(":");
    const v4 = ipv4Number(ipv6.slice(lastColon + 1));
    if (v4 === null) return null;
    ipv6 = `${ipv6.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = ipv6.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
  const parts = [...left, ...Array(omitted).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[\da-f]{1,4}$/.test(part))) return null;
  let first64 = 0n;
  for (let i = 0; i < 4; i++) first64 = (first64 << 16n) | BigInt(parseInt(parts[i]!, 16));
  return { version: 6, value: first64 };
}

async function loadTable(version: Version): Promise<DataView | null> {
  const existing = tables.get(version);
  if (existing) return existing;
  const loading = fetch(`/geoip/ipv${version}.bin?v=20260921`, { cache: "force-cache" })
    .then(async (response) => {
      if (!response.ok) return null;
      const bytes = await response.arrayBuffer();
      const recordSize = version === 4 ? 10 : 18;
      return bytes.byteLength && bytes.byteLength % recordSize === 0 ? new DataView(bytes) : null;
    }).catch(() => null);
  tables.set(version, loading);
  return loading;
}

export async function lookupIpCountryLocal(ip: string): Promise<string | null> {
  const address = parseAddress(ip);
  if (!address) return null;
  const table = await loadTable(address.version);
  if (!table) return null;
  const size = address.version === 4 ? 10 : 18;
  let low = 0;
  let high = table.byteLength / size;
  // Last start <= target. IPv6 can have several ranges sharing the first 64 bits.
  while (low < high) {
    const mid = (low + high) >>> 1;
    const start = address.version === 4 ? table.getUint32(mid * size, true) : table.getBigUint64(mid * size, true);
    if (start <= address.value) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return null;
  const offset = (low - 1) * size;
  const end = address.version === 4 ? table.getUint32(offset + 4, true) : table.getBigUint64(offset + 8, true);
  if (address.value > end) return null;
  const country = String.fromCharCode(table.getUint8(offset + size - 2), table.getUint8(offset + size - 1));
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

