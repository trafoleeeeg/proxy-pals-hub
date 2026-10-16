const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { COMPATIBILITY_DATE, cloudflareBuildEnvironment, buildCloudflare, finalizePagesOutput } = require("../../scripts/build-cloudflare.cjs");
const { ENTRY, MANIFEST, sha256 } = require("../runtime/panel-bundle.cjs");

const publicEnvironment = { VITE_SUPABASE_URL: "https://test.invalid", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_not_real" };

test("Pages build requires explicit public config and rejects the sandbox output override", () => {
  for (const name of Object.keys(publicEnvironment)) {
    const env = { ...publicEnvironment, [name]: " " };
    assert.throws(() => cloudflareBuildEnvironment(env), new RegExp(name));
  }
  for (const sandbox of [{ LOVABLE_SANDBOX: "1" }, { DEV_SERVER__PROJECT_PATH: "/sandbox" }]) {
    assert.throws(() => cloudflareBuildEnvironment({ ...publicEnvironment, ...sandbox }), /outside the Lovable sandbox/);
  }
});

test("Pages never embeds a server key or credentials in its browser configuration", () => {
  const jwt = role => `synthetic.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
  for (const key of ["sb_secret_synthetic", jwt("service_role"), "not-a-public-key"]) {
    assert.throws(() => cloudflareBuildEnvironment({ ...publicEnvironment, VITE_SUPABASE_PUBLISHABLE_KEY: key }), /never a server secret/);
  }
  assert.doesNotThrow(() => cloudflareBuildEnvironment({ ...publicEnvironment, VITE_SUPABASE_PUBLISHABLE_KEY: jwt("anon") }));
  for (const url of ["http://test.invalid", "https://user:secret@test.invalid", "https://test.invalid/path", "https://test.invalid?token=synthetic"]) {
    assert.throws(() => cloudflareBuildEnvironment({ ...publicEnvironment, VITE_SUPABASE_URL: url }), /HTTPS project origin/);
  }
});

test("Pages environment is pinned without mutating the ordinary build environment", () => {
  const input = { ...publicEnvironment, NITRO_PRESET: "node-server", NITRO_COMPATIBILITY_DATE: "2020-01-01", unrelated: "preserved" };
  const output = cloudflareBuildEnvironment(input);
  assert.equal(output.NITRO_PRESET, "cloudflare-pages");
  assert.equal(output.NITRO_COMPATIBILITY_DATE, COMPATIBILITY_DATE);
  assert.equal(output.UMBRA_CLOUDFLARE_BUILD, "1");
  assert.equal(output.unrelated, "preserved");
  assert.equal(input.NITRO_PRESET, "node-server");
  assert.equal(input.NITRO_COMPATIBILITY_DATE, "2020-01-01");
});

test("Pages generates GeoIP then one SSR build then verifies the matching desktop shell", () => {
  const calls = [];
  const root = path.resolve("fixture");
  let finalized = false;
  buildCloudflare({ root, environment: publicEnvironment, spawn: (...args) => { calls.push(args); return { status: 0 }; },
    finalize: () => { assert.equal(calls.length, 3); finalized = true; } });
  assert.equal(finalized, true);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map(call => path.basename(call[1][0])), ["generate-geoip.cjs", "vite.js", "build-panel-bundle.cjs", "verify-cloudflare.cjs", "verify-key-transfer.cjs"]);
  assert.deepEqual(calls[1][1].slice(1), ["build"]);
  for (const [executable, , options] of calls) {
    assert.equal(executable, process.execPath);
    assert.equal(options.cwd, root);
    assert.equal(options.env.NITRO_PRESET, "cloudflare-pages");
    assert.equal(options.stdio, "inherit");
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, undefined);
  }
});

test("a failed or unsupported build step stops before publishing further output", () => {
  for (const failedStep of [0, 1, 2, 3, 4]) {
    for (const failure of [{ status: 1 }, { status: null, signal: "SIGTERM" }, { error: new Error("unsupported worker import") }]) {
      let calls = 0;
      assert.throws(() => buildCloudflare({ environment: publicEnvironment, spawn: () => calls++ === failedStep ? failure : { status: 0 }, finalize() {} }));
      assert.equal(calls, failedStep + 1);
    }
  }
});

test("post-build panel assets bypass SSR while server routes remain protected", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-pages-build-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "dist");
  fs.mkdirSync(directory);
  const files = [{ path: ENTRY, content: "anonymous synthetic shell" }, { path: "/favicon.ico", content: "synthetic icon" }];
  const manifest = { schema: 1, entry: ENTRY, minimumDesktopVersion: "0.4.59", revision: new Date().toISOString(),
    files: files.map(file => ({ path: file.path, size: Buffer.byteLength(file.content), sha256: sha256(Buffer.from(file.content)) })) };
  for (const file of files) fs.writeFileSync(path.join(directory, file.path.slice(1)), file.content);
  fs.writeFileSync(path.join(directory, MANIFEST.slice(1)), JSON.stringify(manifest));
  const routesFile = path.join(directory, "_routes.json");
  fs.writeFileSync(routesFile, JSON.stringify({ version: 1, include: ["/*"], exclude: ["/favicon.ico"] }));
  const redirectsFile = path.join(directory, "_redirects");
  fs.writeFileSync(redirectsFile, "/legacy / 301\n");
  finalizePagesOutput(root, {});
  finalizePagesOutput(root, {});
  const routes = JSON.parse(fs.readFileSync(routesFile));
  assert.deepEqual(routes.include, ["/*"]);
  assert.deepEqual(routes.exclude, ["/favicon.ico", ENTRY, MANIFEST, "/_umbra-panel"]);
  assert.equal(fs.readFileSync(redirectsFile, "utf8"), "/_umbra-panel.html /_umbra-panel 200\n/legacy / 301\n");
  assert(!routes.exclude.includes("/app") && !routes.exclude.includes("/_serverFn/*"));
  assert.throws(() => finalizePagesOutput(root, { APP_ENCRYPTION_KEY: "synthetic shell" }), /Server-only configuration/);
  fs.writeFileSync(redirectsFile, "/_umbra-panel.html https://external.invalid/ 302\n");
  assert.throws(() => finalizePagesOutput(root, {}), /Conflicting desktop panel redirect/);
});

test("existing build remains unchanged and Pages metadata selects SSR output with Node compatibility", () => {
  const root = path.resolve(__dirname, "../..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const config = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
  assert.equal(pkg.scripts.build, "vite build && node scripts/build-panel-bundle.cjs");
  assert.equal(pkg.scripts["build:cloudflare"], "node scripts/build-cloudflare.cjs");
  assert.equal(config.pages_build_output_dir, "./dist");
  assert.equal(config.compatibility_date, COMPATIBILITY_DATE);
  assert(config.compatibility_flags.includes("nodejs_compat"));
  assert.equal(config.vars, undefined);
});
