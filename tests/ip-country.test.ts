import { describe, expect, test } from "bun:test";
import { lookupIpCountryLocal } from "../src/lib/ip-country";

describe("same-origin country lookup", () => {
  test("looks up IPv4 without disclosing the IP in the request", async () => {
    const bytes = new ArrayBuffer(10);
    const table = new DataView(bytes);
    table.setUint32(0, 0x08080808, true);
    table.setUint32(4, 0x08080808, true);
    table.setUint8(8, "U".charCodeAt(0));
    table.setUint8(9, "S".charCodeAt(0));
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(bytes);
    }) as typeof fetch;
    try {
      expect(await lookupIpCountryLocal("8.8.8.8")).toBe("US");
      expect(await lookupIpCountryLocal("8.8.4.4")).toBeNull();
      expect(urls).toEqual(["/geoip/ipv4.bin?v=20260921"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects malformed IPs before loading a table", async () => {
    expect(await lookupIpCountryLocal("not-an-ip")).toBeNull();
    expect(await lookupIpCountryLocal("999.8.8.8")).toBeNull();
    expect(await lookupIpCountryLocal("2001:::1")).toBeNull();
  });

  test("looks up IPv6 from the first 64 bits", async () => {
    const bytes = new ArrayBuffer(18);
    const table = new DataView(bytes);
    table.setBigUint64(0, 0x2001486000000000n, true);
    table.setBigUint64(8, 0x2001486000000000n, true);
    table.setUint8(16, "U".charCodeAt(0));
    table.setUint8(17, "S".charCodeAt(0));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(bytes)) as typeof fetch;
    try {
      expect(await lookupIpCountryLocal("2001:4860::1")).toBe("US");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

