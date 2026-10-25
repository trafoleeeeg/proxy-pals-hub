import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { generateFingerprint } from "../src/lib/fingerprint";
import { normalizeProxyCheck, normalizeProxyHost } from "../src/lib/proxy-input";
import { parseCookieImport } from "../src/lib/server-cookies";
import { bulkCreateSchema, bulkUpdateSchema, saveProfileSchema } from "../src/lib/server-validation";

const id = "10000000-0000-4000-8000-000000000001";
const update = (fingerprint: Record<string, unknown>) => bulkUpdateSchema.parse({
  teamId: id, ids: [id], changes: { fingerprint },
}).changes.fingerprint;

describe("patched validation dependency compatibility", () => {
  test("a partial fingerprint update contains only the supplied setting", () => {
    expect(update({ timezone: "UTC" })).toEqual({ timezone: "UTC" });
    expect(update({ deviceMemory: 4 })).toEqual({ deviceMemory: 4 });
  });

  test("an empty fingerprint patch does not introduce privacy defaults", () => {
    expect(update({})).toEqual({});
  });

  test("explicit privacy flags retain either boolean without adding the other flag", () => {
    for (const value of [false, true]) {
      expect(update({ aggressivePrivacyMode: value })).toEqual({ aggressivePrivacyMode: value });
      expect(update({ fontIsolation: value })).toEqual({ fontIsolation: value });
    }
    expect(update({ aggressivePrivacyMode: false, fontIsolation: true })).toEqual({
      aggressivePrivacyMode: false, fontIsolation: true,
    });
  });

  test("single and bulk profile creation still apply the original privacy defaults", () => {
    const fingerprint: Record<string, unknown> = { ...generateFingerprint("US") };
    delete fingerprint["aggressivePrivacyMode"];
    delete fingerprint["fontIsolation"];
    const single = saveProfileSchema.parse({
      teamId: id, name: "Synthetic dependency check", folder: "", tags: [], notes: "",
      proxyId: null, fingerprint,
    }).fingerprint;
    const bulk = bulkCreateSchema.parse({
      teamId: id, prefix: "Synthetic", count: 1, folder: "", fingerprints: [fingerprint],
    }).fingerprints[0]!;
    for (const result of [single, bulk]) {
      expect(result.aggressivePrivacyMode).toBe(true);
      expect(result.fontIsolation).toBe(false);
    }
    expect(Object.hasOwn(fingerprint, "aggressivePrivacyMode")).toBe(false);
    expect(Object.hasOwn(fingerprint, "fontIsolation")).toBe(false);
  });

  test("successful proxy checks accept both IP families and reject malformed addresses", () => {
    for (const ip of ["203.0.113.7", "2001:db8::7"]) {
      expect(normalizeProxyCheck({ ok: true, ip })).toEqual({ ok: true, ip });
    }
    for (const ip of ["999.0.113.7", "2001:db8::gg", "proxy.example", "[2001:db8::7]"]) {
      expect(() => normalizeProxyCheck({ ok: true, ip })).toThrow();
    }
  });

  test("IPv6 proxy host normalization preserves bracket handling and rejects invalid literals", () => {
    expect(normalizeProxyHost("[2001:0db8::7]")).toBe("2001:db8::7");
    expect(normalizeProxyHost("2001:0db8::7")).toBe("2001:db8::7");
    for (const host of ["[2001:db8::gg]", "[203.0.113.7]", "[::1%25eth0]"]) {
      expect(() => normalizeProxyHost(host)).toThrow();
    }
  });

  test("cookie imports preserve persistent and partitioned session semantics", () => {
    const persistent = {
      name: "persistent", value: "synthetic-only", domain: "example.test", expirationDate: 2_000_000_000,
    };
    const partitioned = {
      name: "session", value: "synthetic-only", domain: "example.test", secure: true, session: true,
      expirationDate: 2_000_000_000,
      partitionKey: { topLevelSite: "https://example.test", hasCrossSiteAncestor: false },
    };
    const cookies = parseCookieImport(JSON.stringify([persistent, partitioned]));
    expect(cookies[0]).toEqual({
      ...persistent, path: "/", secure: false, httpOnly: false, hostOnly: true,
    });
    expect(cookies[1]).toEqual({
      name: partitioned.name, value: partitioned.value, domain: partitioned.domain,
      path: "/", secure: true, httpOnly: false, hostOnly: true, session: true,
      partitionKey: partitioned.partitionKey,
    });
    expect(parseCookieImport(JSON.stringify(cookies))).toEqual(cookies);
  });

  test("the patched collection cap rejects excess input before visiting its entries", () => {
    let visited = 0;
    const schema = z.array(z.string().refine(() => { visited++; return true; })).max(2);
    const result = schema.safeParse(["one", "two", "three"]);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Oversized input must be rejected");
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.code).toBe("too_big");
    expect(visited).toBe(0);
    expect(schema.parse(["one", "two"])).toEqual(["one", "two"]);
    expect(visited).toBe(2);
  });
});
