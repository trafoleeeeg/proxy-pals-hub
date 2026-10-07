import { expect, test } from "bun:test";
import { parseCookieImport, cookieImportErrorMessage } from "../src/lib/server-cookies";
import { normalizeCookiePartition } from "../src/lib/cookie-partition";
import { createRequire } from "node:module";
const native = createRequire(import.meta.url)("../desktop/runtime/cookie-partition.cjs");

test("server import rejects incomplete/opaque partitions instead of stripping their security boundary", () => {
  for (const partition of [{ partitionKey: { topLevelSite: "https://example.test" } }, { partitioned: true }, { partitionKeyOpaque: true }]) {
    const input = JSON.stringify([{ name: "fixture", value: "synthetic-cookie", domain: "example.test", ...partition }]);
    expect(() => parseCookieImport(input)).toThrow("CHIPS");
  }
  expect(parseCookieImport('[{"name":"fixture","value":"synthetic","domain":"example.test","partitionKey":null}]')).toHaveLength(1);
});

test("CHIPS keys survive JSON import and both validators agree on legacy ancestor defaults", () => {
  for (const domain of [".site.test", "sub.site.test", "other.test"]) for (const ancestor of [undefined, false, true]) {
    const cookie = { name: "fixture", value: "synthetic", domain, secure: true,
      partitionKey: { topLevelSite: "https://site.test", ...(ancestor === undefined ? {} : { hasCrossSiteAncestor: ancestor }) } };
    const normalized = normalizeCookiePartition(cookie);
    expect(native.normalizeCookiePartition(cookie)).toEqual(normalized);
    expect(parseCookieImport(JSON.stringify([cookie]))[0]!.partitionKey).toEqual(normalized);
    expect(normalized?.hasCrossSiteAncestor).toBe(ancestor ?? domain === "other.test");
  }
});

test("unsafe keys fail without including private cookie values in UI errors", () => {
  for (const partitionKey of [{}, { topLevelSite: "file:///private" }, { topLevelSite: "https://a:b@site.test" },
    { topLevelSite: "https://site.test/path" }, { topLevelSite: "https://site.test", hasCrossSiteAncestor: "true" },
    { topLevelSite: "https://site.test", nonce: "opaque" }, { topLevelSite: "https://site.test", hasCrossSiteAncestor: null }]) {
    const cookie = { name: "fixture", value: "private-synthetic-cookie", domain: "site.test", secure: true, partitionKey };
    expect(() => normalizeCookiePartition(cookie)).toThrow("CHIPS");
    expect(() => native.normalizeCookiePartition(cookie)).toThrow("CHIPS");
  }
  expect(cookieImportErrorMessage(new Error("private-synthetic-cookie"))).not.toContain("private-synthetic-cookie");
  expect(cookieImportErrorMessage(new Error("Invalid cookie at position 7"))).toContain("№7");
});
