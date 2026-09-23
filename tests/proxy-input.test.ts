import { describe, expect, test } from "bun:test";
import {
  DESKTOP_PROXY_CHECK_REQUIRED, PROXY_LIMITS, ProxyCheckQueue, normalizeProxyCheck,
  normalizeProxyHost, parseProxyBundle, parseProxyImport, parseProxyLine, parseProxyPort,
  performDesktopProxyCheck, proxyAddress, validateProxyFields, validateProxyInput,
  validateProxyTarget, validateProxyTeam, validateRotationUrl,
} from "../src/lib/proxy-input";

const teamId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const fields = { protocol: "http", host: "proxy.example", port: 8080 };
const input = { ...fields, teamId, label: "Test proxy" };

describe("proxy addresses and credentials", () => {
  test("detects vendor-style protocol, credentials and rotation URL in one paste", () => {
    const parsed = parseProxyBundle("socks5: proxy.example:1080:user:pass\nhttps://rotate.example/change?token=test&wait=1");
    expect(parsed).toMatchObject({
      protocol: "socks5", host: "proxy.example", port: 1080,
      username: "user", password: "pass", rotationUrl: "https://rotate.example/change?token=test&wait=1",
    });
    expect(parseProxyBundle("http://user:pass@proxy.example:8080")).toMatchObject({
      protocol: "http", host: "proxy.example", username: "user", password: "pass",
    });
    expect(parseProxyBundle("socks5: proxy.example:1080:user:pass\n[https://rotate.example/change?token=x](https://rotate.example/change?token=x\\&wait=1)")?.rotationUrl)
      .toBe("https://rotate.example/change?token=x&wait=1");
    expect(parseProxyBundle("proxy.example:8080\nproxy2.example:8080")).toBeNull();
    expect(parseProxyBundle("proxy.example:8080\nhttps://proxy2.example:443")).toBeNull();
    expect(parseProxyBundle("ordinary note")).toBeNull();
    expect(() => parseProxyBundle("socks5: not a proxy\nhttps://rotate.example/change")).toThrow("Не удалось распознать");
  });

  test.each([
    ["proxy.example:8080", "http", "proxy.example", 8080, "", ""],
    ["proxy.example:8080:login:pa:ss@word%25", "http", "proxy.example", 8080, "login", "pa:ss@word%25"],
    ["proxy.example:8080:login:p%40ss", "http", "proxy.example", 8080, "login", "p%40ss"],
    ["[2001:0db8::1]:1080:login:p:@%", "http", "2001:db8::1", 1080, "login", "p:@%"],
    ["http://login:p%3Aa%40ss%25%2520@PROXY.example:80/", "http", "proxy.example", 80, "login", "p:a@ss%%20"],
    ["HTTPS://login:p:a@ss%25@proxy.example:443", "https", "proxy.example", 443, "login", "p:a@ss%"],
    ["socks5://u%3Aser:p%40ss%25@[2001:db8::1]:1080", "socks5", "2001:db8::1", 1080, "u:ser", "p@ss%"],
    ["login:p%3Aa%40ss%25@proxy.example:8080", "http", "proxy.example", 8080, "login", "p:a@ss%"],
    ["login:123@proxy.example:8080", "http", "proxy.example", 8080, "login", "123"],
    ["http://proxy.example:80", "http", "proxy.example", 80, "", ""],
  ])("parses %s without changing the password", (line, protocol, host, port, username, password) => {
    expect(parseProxyLine(line as string)).toEqual({
      protocol, host, port, username, password, country: "", label: proxyAddress(host as string, port),
    });
  });

  test("keeps whitespace in a colon-format password", () => {
    expect(parseProxyLine("proxy.example:8080:login: p@ss% ").password).toBe(" p@ss% ");
    expect(parseProxyLine("  proxy.example:8080  ")).toEqual(parseProxyLine("proxy.example:8080"));
    expect(parseProxyLine(" [::1]:1080 ").host).toBe("::1");
  });

  test("uses the selected protocol only for lines without a scheme", () => {
    expect(parseProxyLine("[::1]:1080:u:p", "socks5").protocol).toBe("socks5");
    expect(parseProxyLine("u:p@proxy.example:1080", "socks5").protocol).toBe("socks5");
    expect(parseProxyLine("https://proxy.example:443", "socks5").protocol).toBe("https");
  });

  test.each([
    "ftp://proxy.example:21", "http://proxy.example", "2001:db8::1:1080",
    "[not-ipv6]:1080", "http://proxy.example:80/path", "http:///proxy.example:80",
    "http://proxy.example:80?x=1", "http://proxy.example:80#fragment",
    "http://user:bad%escape@proxy.example:80", "http://user:bad%0Apassword@proxy.example:80",
    "http://u%3Aser:p@proxy.example:80", "http://proxy.example:80\\path",
    "proxy.example:0", "proxy.example:65536", "proxy.example:1e3", "proxy.example:1.5",
    "proxy.example:80:u:p\t", "http://:password@proxy.example:80",
  ])("rejects invalid proxy input %s", (line) => {
    expect(() => parseProxyLine(line)).toThrow();
  });

  test("normalizes hostnames, IDN, and IPv6 for desktop", () => {
    expect(normalizeProxyHost(" Proxy.Example. ")).toBe("proxy.example");
    expect(normalizeProxyHost("b\u00fccher.example")).toBe("xn--bcher-kva.example");
    expect(normalizeProxyHost("[2001:0db8:0:0::1]")).toBe("2001:db8::1");
    expect(proxyAddress("::1", 1080)).toBe("[::1]:1080");
    for (const host of ["https://example.com", "example.com:80", "a_b.example", "-a.example", "a..example", "example.com/a", "[::1%25eth0]", "a".repeat(64)]) {
      expect(() => normalizeProxyHost(host)).toThrow();
    }
  });

  test("requires an integer TCP port", () => {
    for (const value of [1, 65535, "00080"]) expect(parseProxyPort(value)).toBe(Number(value));
    for (const value of [0, -1, 65536, 1.5, NaN, Infinity, " 80", "80 ", "+80", "1e3", "", null, true]) {
      expect(() => parseProxyPort(value)).toThrow();
    }
  });

  test("validates byte limits and rejects credentials the desktop cannot use", () => {
    expect(validateProxyFields({ ...fields, username: "u", password: "x".repeat(1024) }).password).toHaveLength(1024);
    expect(validateProxyFields({ ...fields, protocol: "socks5", username: "u", password: "x".repeat(255) }).password).toHaveLength(255);
    for (const invalid of [
      { password: "p" }, { username: "u:p" }, { username: "u", password: "x".repeat(1025) },
      { username: "u", password: "\u00e9".repeat(513) },
      { protocol: "socks5", username: "\u00e9".repeat(128) },
      { protocol: "socks5", username: "u", password: "x".repeat(256) },
      { username: "u\0" }, { label: "x".repeat(201) }, { country: "USA" },
    ]) expect(() => validateProxyFields({ ...fields, ...invalid })).toThrow();
    expect(validateProxyFields({ ...fields, country: "de" }).country).toBe("DE");
  });
});

describe("proxy import limits", () => {
  test("reports original line numbers and never echoes credentials in issues", () => {
    const result = parseProxyImport("proxy.example:80\r\n\r\nhttp://u:private%oops@host:80\r[::1]:1080");
    expect(result.rows).toHaveLength(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.line).toBe(3);
    expect(JSON.stringify(result.issues)).not.toContain("private");
  });

  test("bounds the number of lines, UTF-8 bytes and line length", () => {
    expect(parseProxyImport(Array(500).fill("proxy.example:80").join("\n")).rows).toHaveLength(500);
    expect(() => parseProxyImport(Array(501).fill("proxy.example:80").join("\n"))).toThrow();
    expect(() => parseProxyImport("x".repeat(PROXY_LIMITS.importBytes + 1))).toThrow();
    expect(() => parseProxyImport("\u00e9".repeat(PROXY_LIMITS.importBytes / 2 + 1))).toThrow();
    expect(parseProxyImport("x".repeat(PROXY_LIMITS.lineLength + 1)).issues).toHaveLength(1);
    for (const text of ["", "\n  \r\n", null, []]) expect(() => parseProxyImport(text)).toThrow();
  });
});

describe("proxy identity and password actions", () => {
  test("requires valid UUIDs and strips unrecognized fields", () => {
    expect(validateProxyTeam({ teamId, admin: true })).toEqual({ teamId });
    expect(validateProxyTarget({ teamId, id, owner: true })).toEqual({ teamId, id });
    for (const value of [null, [], {}, { teamId: "bad" }, { teamId, id: "bad" }]) {
      expect(() => validateProxyTarget(value)).toThrow();
    }
    const result = validateProxyInput({ ...input, created_by: "other", team_id: "other", password_enc: "injected" });
    expect(result).not.toHaveProperty("created_by");
    expect(result).not.toHaveProperty("team_id");
    expect(result).not.toHaveProperty("password_enc");
  });

  test("preserves an omitted or blank password on edit and clears it only explicitly", () => {
    expect(validateProxyInput(input).passwordAction).toBe("clear");
    expect(validateProxyInput({ ...input, id }).passwordAction).toBe("preserve");
    expect(validateProxyInput({ ...input, id, password: "" }).passwordAction).toBe("preserve");
    expect(validateProxyInput({ ...input, id, passwordAction: "clear" }).passwordAction).toBe("clear");
    expect(validateProxyInput({ ...input, id, username: "u", password: "p" }).passwordAction).toBe("replace");
    for (const extra of [
      { passwordAction: "invalid" }, { passwordAction: "replace", password: "" },
      { passwordAction: "clear", password: "p" }, { passwordAction: "preserve", password: "p" },
    ]) expect(() => validateProxyInput({ ...input, id, username: "u", ...extra })).toThrow();
  });

  test("accepts only safe HTTPS rotation links and keeps rotation actions explicit", () => {
    expect(validateRotationUrl("https://mobile.example/rotate?token=abc")).toBe("https://mobile.example/rotate?token=abc");
    for (const value of ["http://mobile.example/rotate", "javascript:alert(1)", "https://localhost/rotate", "https://192.168.1.4/rotate", "https://u:p@mobile.example/rotate"]) {
      expect(() => validateRotationUrl(value)).toThrow();
    }
    expect(validateProxyInput({ ...input, rotationUrl: "https://mobile.example/rotate", rotationAction: "replace" }).rotationAction).toBe("replace");
    expect(() => validateProxyInput({ ...input, rotationUrl: "https://mobile.example/rotate", rotationAction: "clear" })).toThrow();
  });
});

describe("desktop proxy results", () => {
  test("requires a real IP on success and bounds latency and locale", () => {
    expect(normalizeProxyCheck({ ok: true, ip: "2001:db8::1", latency: 0, country: "de", city: "Berlin" }))
      .toEqual({ ok: true, ip: "2001:db8::1", latency: 0, country: "DE", city: "Berlin" });
    for (const value of [
      { ok: "true" }, { ok: true }, { ok: true, ip: "example.com" },
      { ok: true, ip: "1.2.3.4", latency: -1 }, { ok: false, latency: 120001 },
      { ok: false, latency: 1.5 }, { ok: false, latency: NaN },
      { ok: true, ip: "1.2.3.4", country: "USA" }, { ok: true, ip: "1.2.3.4", city: "x".repeat(121) },
    ]) expect(() => normalizeProxyCheck(value)).toThrow();
    expect(normalizeProxyCheck({ ok: true, ip: "1.2.3.4", country: undefined, city: undefined }))
      .toEqual({ ok: true, ip: "1.2.3.4" });
  });

  test("discards raw errors and stale IP/locale from failed checks", () => {
    const result = normalizeProxyCheck({ ok: false, ip: "1.2.3.4", country: "DE", city: "Berlin", error: "http://u:secret@host:80", latency: 25 });
    expect(result).toEqual({ ok: false, error: expect.any(String), latency: 25 });
    expect(result.error).not.toContain("secret");
  });

  test("records a completed desktop check before reporting success", async () => {
    const events: string[] = [];
    const target = { password: "private" };
    const result = await performDesktopProxyCheck({
      load: async () => { events.push("load"); return target; },
      check: async (value) => { expect(value).toBe(target); events.push("check"); return { ok: true, result: { ok: true, ip: "1.2.3.4" } }; },
      record: async (value) => { events.push("record"); expect(value).toEqual({ ok: true, ip: "1.2.3.4" }); },
    });
    expect(events).toEqual(["load", "check", "record"]);
    expect(result.ok).toBe(true);
  });

  test("does not record failed IPC or invalid results, and hides raw failure details", async () => {
    for (const stage of ["load", "ipc", "envelope", "invalid", "record"]) {
      let checks = 0; let records = 0;
      const attempt = performDesktopProxyCheck({
        load: async () => { if (stage === "load") throw new Error("private"); return {}; },
        check: async () => {
          checks++;
          if (stage === "ipc") throw new Error("private");
          if (stage === "envelope") return { ok: false };
          return { ok: true, result: { ok: true, ip: stage === "invalid" ? "private" : "1.2.3.4" } };
        },
        record: async () => { records++; throw new Error("private"); },
      });
      await expect(attempt).rejects.toThrow();
      await attempt.catch((error) => expect(error.message).not.toContain("private"));
      expect(checks).toBe(stage === "load" ? 0 : 1);
      expect(records).toBe(stage === "record" ? 1 : 0);
    }
  });

  test("records a genuine failed probe but rejects desktop_required as a check result", async () => {
    let recorded;
    const result = await performDesktopProxyCheck({
      load: async () => ({}),
      check: async () => ({ ok: true, result: { ok: false, error: "http://u:private@host:80" } }),
      record: async (value) => { recorded = value; },
    });
    expect(result.ok).toBe(false);
    expect(recorded).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(() => normalizeProxyCheck(DESKTOP_PROXY_CHECK_REQUIRED)).toThrow();
  });

  test("bounds queued checks, coalesces duplicates and recovers after rejection", async () => {
    const queue = new ProxyCheckQueue(2);
    const releases: (() => void)[] = [];
    const started: string[] = [];
    const run = (id: string) => queue.run(id, async () => {
      started.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
      if (id === "a") throw new Error("probe failed");
      return id;
    });
    const a = run("a"); const b = run("b"); const c = run("c");
    const failed = a.catch((error) => error);
    expect(run("a")).toBe(a);
    expect(run("c")).toBe(c);
    expect(started).toEqual(["a", "b"]);
    releases.shift()!(); expect((await failed).message).toBe("probe failed");
    expect(started).toEqual(["a", "b", "c"]);
    releases.splice(0).forEach((release) => release());
    expect(await Promise.all([b, c])).toEqual(["b", "c"]);
    expect(await queue.run("a", async () => "retry")).toBe("retry");
    for (const limit of [0, -1, 1.5, Infinity]) expect(() => new ProxyCheckQueue(limit)).toThrow();
  });
});
