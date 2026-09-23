import { expect, test } from "bun:test";
import { parseCookieImport } from "../src/lib/server-cookies";

test("server import rejects partitioned cookies instead of stripping their security boundary", () => {
  for (const partition of [{ partitionKey: { topLevelSite: "https://example.test" } }, { partitioned: true }, { partitionKeyOpaque: true }]) {
    const input = JSON.stringify([{ name: "fixture", value: "synthetic-cookie", domain: "example.test", ...partition }]);
    expect(() => parseCookieImport(input)).toThrow("CHIPS");
  }
  expect(parseCookieImport('[{"name":"fixture","value":"synthetic","domain":"example.test","partitionKey":null}]')).toHaveLength(1);
});
