const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { resolveBuildOutput, validateAnonymousShell, renderAnonymousShell, assertShellTarget } = require("../../scripts/panel-build-source.cjs");

const rootMatch = '{i:"__root__\\u0000",u:123,s:"success",ssr:!0}';
const shell = `<html><script>${rootMatch}</script></html>`;

test("Lovable selects one matching server/client pair, never stale .output", () => {
  const root = path.resolve("fixture");
  for (const env of [{ LOVABLE_SANDBOX: "1" }, { DEV_SERVER__PROJECT_PATH: "/dev-server" },
    { LOVABLE_SANDBOX: "1", LOVABLE_NITRO_PRESET: "lovable-fetch-bundle" }]) {
    assert.deepEqual(resolveBuildOutput(root, env), {
      publicDirectory: path.join(root, "dist/client"), serverEntry: path.join(root, "dist/server/index.mjs"),
    });
  }
  for (const env of [{}, { LOVABLE_SANDBOX: "0", DEV_SERVER__PROJECT_PATH: "" }]) {
    assert.deepEqual(resolveBuildOutput(root, env), {
      publicDirectory: path.join(root, ".output/public"), serverEntry: path.join(root, ".output/server/index.mjs"),
    });
  }
});

test("only anonymous root or non-rendered pending matches enter the panel", () => {
  assert.equal(validateAnonymousShell(shell), shell);
  assert.doesNotThrow(() => validateAnonymousShell(shell.replace("\\u0000", "\u0000")));
  const pending = shell.replace("</script>", ',{i:"/_authenticated/app",u:123,s:"pending",ssr:!1}</script>');
  assert.equal(validateAnonymousShell(pending), pending);
  for (const forbidden of ["access_token", "refresh_token", "cookies_enc"]) {
    assert.throws(() => validateAnonymousShell(shell + forbidden), /must be anonymous/);
  }
  for (const addition of ['{i:"/_authenticated/app",u:123,s:"success",ssr:!1}',
    '{i:"/_authenticated/app",u:123,s:"pending",ssr:!0}']) {
    assert.throws(() => validateAnonymousShell(shell.replace("</script>", addition + "</script>")), /must be anonymous/);
  }
  for (const invalid of ["<html>private SSR</html>", 'lastMatchId:"__root__"', shell.replace("__root__", "__root__private")]) {
    assert.throws(() => validateAnonymousShell(invalid), /must be anonymous/);
  }
});

test("server render carries shell header but no user cookies or authorization", async () => {
  const handler = { fetch: async (request, env) => {
    assert.equal(request.url, "https://localhost/app");
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("X-TSS_SHELL"), "true");
    assert.equal(request.headers.get("Cookie"), null);
    assert.equal(request.headers.get("Authorization"), null);
    assert.deepEqual(env, {});
    return new Response(shell, { headers: { "content-type": "text/html; charset=utf-8" } });
  } };
  assert.equal(await renderAnonymousShell(handler), shell);
  for (const response of [new Response("", { status: 302 }), new Response(shell),
    new Response("private", { headers: { "content-type": "text/html" } })]) {
    await assert.rejects(renderAnonymousShell({ fetch: async () => response }));
  }
});

test("unexpected directory at the panel entry is not recursively removed", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-build-source-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "_umbra-panel.html");
  assert.doesNotThrow(() => assertShellTarget(target));
  fs.mkdirSync(target);
  assert.throws(() => assertShellTarget(target), /regular file/);
  assert(fs.statSync(target).isDirectory());
});
