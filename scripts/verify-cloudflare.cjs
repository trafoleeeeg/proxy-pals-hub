// Offline checks of the actual built Pages worker. No user tokens, live DB
// requests or Cloudflare account credentials are needed for these assertions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { toJSON, fromCrossJSON } = require("seroval");
const { ENTRY, MANIFEST, sha256, loadBundled } = require("../desktop/runtime/panel-bundle.cjs");
const { validateAnonymousShell } = require("./panel-build-source.cjs");

(async () => {
  // Runtime secrets do not need to be available to a Pages build. This child
  // process tests only rejection before authentication, with synthetic config.
  process.env.SUPABASE_URL = "https://migration-test.invalid";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_synthetic_not_real";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.APP_ENCRYPTION_KEY;
  const { defaultSerovalDeserializerPlugins } = await import("@tanstack/router-core/ssr/client");
  const root = path.resolve(__dirname, "..");
  const directory = path.join(root, "dist");
  const bundle = loadBundled(directory);
  const routes = JSON.parse(fs.readFileSync(path.join(directory, "_routes.json"), "utf8"));
  assert(routes.include.includes("/*"), "SSR and API routes must reach the worker");
  assert(routes.exclude.includes(ENTRY) && routes.exclude.includes(MANIFEST), "panel resources must reach static asset serving");
  assert(!routes.exclude.some(route => ["/*", "/app", "/_serverFn/*"].includes(route)), "private routes must not bypass server checks");
  for (const file of bundle.manifest.files) {
    assert(file.path === ENTRY || file.path === "/favicon.ico" || file.path.startsWith("/assets/"));
  }
  const clientCode = [...bundle.bytes].filter(([name]) => name.endsWith(".js")).map(([, bytes]) => bytes.toString("utf8")).join("\n");
  for (const name of ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"]) {
    if (process.env[name]) assert(clientCode.includes(process.env[name]), `Public output does not use the supplied ${name}`);
  }
  let upstreamRequests = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { upstreamRequests++; throw new Error("Offline verification cannot contact an upstream service"); };
  try {
    const { default: worker } = await import(pathToFileURL(path.join(directory, "_worker.js/index.js")).href);
    const context = { waitUntil() {}, passThroughOnException() {} };
    const response = await worker.fetch(new Request("https://migration-test.invalid/auth"), {}, context);
    assert.equal(response.status, 200, "sign-in page must server-render");
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert((await response.text()).includes('type="password"'), "sign-in form must be present");
    const privatePage = await worker.fetch(new Request("https://migration-test.invalid/app"), {}, context);
    // The authenticated route deliberately has ssr:false. Its server response
    // is the anonymous shell; credentials are checked before client loaders.
    assert.equal(privatePage.status, 200, "workspace shell must load");
    validateAnonymousShell(await privatePage.text());
    const id = sha256("src/lib/team.functions.ts--listWorkspaces_createServerFn_handler");
    const rpc = await worker.fetch(new Request(`https://migration-test.invalid/_serverFn/${id}`, {
      method: "POST", headers: { "content-type": "application/json", origin: "https://migration-test.invalid", "x-tsr-serverfn": "true" },
      body: JSON.stringify(toJSON({ data: null })),
    }), {}, context);
    const body = await rpc.json();
    if (rpc.status === 401) assert.equal(body.error, "unauthorized");
    else {
      // TanStack can serialize a rejected function into HTTP 200. Decode the
      // protocol, as its client does, and require the exact auth error with no
      // result; HTTP 200 alone is never treated as successful access.
      assert.equal(rpc.status, 200);
      assert.equal(rpc.headers.get("x-tss-serialized"), "true");
      const decoded = fromCrossJSON(body, { refs: new Map(), plugins: defaultSerovalDeserializerPlugins });
      const error = decoded instanceof Error ? decoded : decoded?.error;
      assert(error instanceof Error && /^Unauthorized:/.test(error.message), "unauthenticated function must reject with an auth error");
      assert.equal(decoded.result, undefined, "unauthenticated function must never return data");
    }
    assert.equal(upstreamRequests, 0, "verification must never contact a database");
  } finally { globalThis.fetch = previousFetch; }
  console.log("Verified Pages worker: SSR sign-in, anonymous workspace shell, unauthenticated RPC rejection, static panel integrity; no upstream requests");
})().catch(error => { console.error(error.message); process.exitCode = 1; });
