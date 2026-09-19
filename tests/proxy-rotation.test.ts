import { expect, test } from "bun:test";
import { confirmRotation, rotationExpired, rotationOutcome } from "../src/lib/proxy-rotation";
import { validateRotationUrl } from "../src/lib/proxy-input";

test("rotation completes on the first different IP; failures and unchanged addresses remain pending", async () => {
  expect(rotationOutcome("1.2.3.4", { ok: true, ip: "1.2.3.4" }, false)).toBe("changing");
  expect(rotationOutcome("1.2.3.4", { ok: false }, false)).toBe("changing");
  expect(rotationOutcome(null, { ok: true, ip: "1.2.3.5" }, true)).toBe("error");
  const records: unknown[] = [];
  let attempt = 0;
  const result = await confirmRotation({
    previousIp: "1.2.3.4",
    probe: async () => (++attempt === 1 ? { ok: false } : { ok: true, ip: attempt === 2 ? "1.2.3.4" : "1.2.3.5" }),
    record: async (...args) => { records.push(args); }, wait: async () => {},
  });
  expect(result.ip).toBe("1.2.3.5");
  expect(result.rotationConfirmed).toBe(true);
  expect(records).toHaveLength(3);
  const finals: boolean[] = [];
  await expect(confirmRotation({
    previousIp: "1.2.3.4", probe: async () => ({ ok: true, ip: "1.2.3.4" }), attempts: 2,
    record: async (_result, final) => { finals.push(final); }, wait: async () => {},
  })).rejects.toThrow("не подтверждён");
  expect(finals).toEqual([false, true]);
});

test("rotation immediately confirms the first changed address", async () => {
  const ips = ["1.2.3.4", "1.2.3.5", "1.2.3.6"];
  const records: Array<[unknown, boolean, boolean]> = [];
  const result = await confirmRotation({
    previousIp: "1.2.3.4",
    probe: async () => ({ ok: true, ip: ips.shift() }),
    record: async (value, final, confirmed) => { records.push([value, final, confirmed]); },
    wait: async () => {},
  });
  expect(result.ip).toBe("1.2.3.5");
  expect(records).toHaveLength(2);
  expect(records.at(-1)?.[1]).toBe(true);
  expect(records.at(-1)?.[2]).toBe(true);
});

test("a superseded rotation stops quietly after saving the fresh IP", async () => {
  let probes = 0;
  const result = await confirmRotation({
    previousIp: "1.2.3.4",
    probe: async () => { probes++; return { ok: true, ip: "1.2.3.6" }; },
    record: async () => ({ ok: true, staleRotation: true }),
    wait: async () => {},
  });
  expect(result).toMatchObject({ ok: true, ip: "1.2.3.6", rotationConfirmed: false });
  expect(probes).toBe(1);
});

test("stale rotations recover and private destinations are rejected", () => {
  expect(rotationExpired(new Date(0).toISOString(), 90_000)).toBe(true);
  expect(rotationExpired("invalid")).toBe(true);
  expect(rotationExpired(new Date().toISOString())).toBe(false);
  for (const url of ["https://127.2.3.4", "https://localhost.", "https://a.localhost", "https://[::ffff:127.0.0.1]", "https://[fe80::1]", "https://2130706433", "https://100.64.0.1", "https://0.1.2.3"]) {
    expect(() => validateRotationUrl(url)).toThrow();
  }
  expect(() => validateRotationUrl("", false)).toThrow();
});
