const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { ENTRY, MANIFEST, loadBundled } = require("../desktop/runtime/panel-bundle.cjs");

// Pin an already available provider date, rather than the laptop's local date
// (which can be one day ahead of Cloudflare UTC).
const COMPATIBILITY_DATE = "2026-10-01";

function cloudflareBuildEnvironment(environment) {
  if (environment.LOVABLE_SANDBOX === "1" || environment.DEV_SERVER__PROJECT_PATH) {
    throw new Error("build:cloudflare must run outside the Lovable sandbox, which overrides Nitro output");
  }
  // Require explicit public config: never silently compile the checked-in
  // Lovable project's .env defaults into an independent Pages deployment.
  for (const name of ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"]) {
    if (!environment[name]?.trim()) throw new Error(`Cloudflare build requires ${name} in the build environment`);
  }
  const url = new URL(environment.VITE_SUPABASE_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("VITE_SUPABASE_URL must be an HTTPS project origin");
  }
  const key = environment.VITE_SUPABASE_PUBLISHABLE_KEY;
  let anonymousJwt = false;
  if (key.split(".").length === 3) {
    try { anonymousJwt = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role === "anon"; }
    catch { /* Invalid public key; never print its contents. */ }
  }
  if (!key.startsWith("sb_publishable_") && !anonymousJwt) {
    throw new Error("VITE_SUPABASE_PUBLISHABLE_KEY must be a publishable or legacy anon key, never a server secret");
  }
  return {
    ...environment,
    UMBRA_CLOUDFLARE_BUILD: "1",
    NITRO_PRESET: "cloudflare-pages",
    NITRO_COMPATIBILITY_DATE: COMPATIBILITY_DATE,
  };
}

function finalizePagesOutput(root, environment) {
  const directory = path.join(root, "dist");
  const bundle = loadBundled(directory);
  // These two files are generated after Nitro enumerates static assets. They
  // must bypass the SSR worker too, otherwise panel updates receive a 404 page.
  const routesFile = path.join(directory, "_routes.json");
  const routes = JSON.parse(fs.readFileSync(routesFile, "utf8"));
  if (routes.version !== 1 || !Array.isArray(routes.include) || !Array.isArray(routes.exclude)) {
    throw new Error("Invalid Cloudflare Pages routes");
  }
  routes.exclude = [...new Set([...routes.exclude, ENTRY, MANIFEST])];
  if (routes.include.length + routes.exclude.length > 100) throw new Error("Cloudflare Pages routing limit exceeded");
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "APP_ENCRYPTION_KEY"]) {
    const value = environment[name];
    if (!value || value.length < 8) continue;
    for (const file of [...bundle.manifest.files, { path: MANIFEST }]) {
      if (fs.readFileSync(path.join(directory, file.path.slice(1))).includes(value)) {
        throw new Error(`Server-only configuration appears in public output: ${name}`);
      }
    }
  }
  fs.writeFileSync(routesFile, JSON.stringify(routes, null, 2) + "\n");
}

function buildCloudflare({ root = path.resolve(__dirname, ".."), environment = process.env, spawn = spawnSync,
  finalize = finalizePagesOutput } = {}) {
  const env = cloudflareBuildEnvironment(environment);
  const vite = path.join(path.dirname(require.resolve("vite/package.json")), "bin/vite.js");
  // One Vite build produces both server RPCs and client chunks. Generating the
  // panel from that exact worker avoids mixing hashes from two different builds.
  const commands = [
    [path.join(root, "scripts/generate-geoip.cjs")],
    [vite, "build"],
    [path.join(root, "scripts/build-panel-bundle.cjs")],
  ];
  function run(args) {
    const result = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0 || result.signal) {
      throw new Error(`Cloudflare build step failed: ${path.basename(args[0])} (${result.signal || result.status})`);
    }
  }
  for (const args of commands) run(args);
  finalize(root, env);
  run([path.join(root, "scripts/verify-cloudflare.cjs")]);
  run([path.join(root, "scripts/verify-key-transfer.cjs")]);
}

if (require.main === module) {
  try { buildCloudflare(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { COMPATIBILITY_DATE, cloudflareBuildEnvironment, buildCloudflare, finalizePagesOutput };
