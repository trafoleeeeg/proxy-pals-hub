import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseCookieImport } from "../src/lib/server-cookies";
import { synchronizedCookies } from "../desktop/runtime/cookie-identity.cjs";
import { saveSessionSchema } from "../src/lib/server-validation";

const hash = (cookies: Parameters<typeof synchronizedCookies>[0]) => createHash("sha256").update(synchronizedCookies(cookies)).digest("hex");
test("native synchronized cookie identity matches server normalization including CHIPS and defaults", () => {
  const rows = [{ name: "A", value: "synthetic", domain: ".example.test", path: "/", secure: true, httpOnly: true, hostOnly: false,
    session: false, expirationDate: 1822909376.43933, sameSite: "no_restriction", partitionKey: { hasCrossSiteAncestor: true, topLevelSite: "https://example.test" } },
    { name: "b", value: "session", domain: "example.test", session: true, expirationDate: 0, url: "ignored-native-field" }];
  expect(hash(rows)).toBe(hash(parseCookieImport(JSON.stringify(rows))));
  expect(hash(rows)).toBe(hash(rows.toReversed().map(row => Object.fromEntries(Object.entries(row).toReversed()) as typeof rows[number])));
  expect(hash(rows)).not.toBe(hash([{ ...rows[0]!, partitionKey: { topLevelSite: "https://example.test", hasCrossSiteAncestor: false } }, rows[1]!]));
  expect(hash(rows)).not.toBe(hash([{ ...rows[0]!, httpOnly: false }, rows[1]!]));
});
test("save protocol requires both durable identity and nullable expected base; legacy stays valid", () => {
  const profileId = crypto.randomUUID(), saveId = crypto.randomUUID();
  expect(saveSessionSchema.safeParse({ profileId, cookies: "[]" }).success).toBe(true);
  expect(saveSessionSchema.safeParse({ profileId, cookies: "[]", saveId, baseRevision: null }).success).toBe(true);
  expect(saveSessionSchema.safeParse({ profileId, cookies: "[]", saveId }).success).toBe(false);
  expect(saveSessionSchema.safeParse({ profileId, cookies: "[]", baseRevision: null }).success).toBe(false);
});
