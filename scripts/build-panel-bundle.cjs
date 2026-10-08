const fs = require("node:fs");
const path = require("node:path");
const { ENTRY, MANIFEST, sha256, validateManifest, loadBundled } = require("../desktop/runtime/panel-bundle.cjs");

const root = path.resolve(__dirname, "..");
const publicDirectory = [".output/public", "dist/client"].map(dir => path.join(root, dir)).find(dir => fs.existsSync(path.join(dir, "assets"))) || path.join(root, ".output/public");
const desktopDirectory = path.join(root, "desktop/.panel");
async function ensureShell() {
  const flat = path.join(publicDirectory, ENTRY.slice(1));
  if (fs.existsSync(flat) && fs.lstatSync(flat).isDirectory()) fs.rmSync(flat, { recursive: true, force: true });
  // Render the anonymous root-only SPA shell from the built server bundle.
  const serverEntry = [".output/server/index.mjs", "dist/server/index.mjs"].map(p => path.join(root, p)).find(p => fs.existsSync(p));
  if (!serverEntry) throw new Error("Built server entry not found");
  const handler = (await import(require("node:url").pathToFileURL(serverEntry).href)).default;
  const response = await handler.fetch(new Request("https://localhost/app", { headers: { "X-TSS_SHELL": "true", Accept: "text/html" }, redirect: "manual" }),
    {}, { waitUntil() {}, passThroughOnException() {} });
  if (response.status !== 200) throw new Error("Panel shell render failed: " + response.status);
  fs.writeFileSync(flat, await response.text());
}

(async () => {
await ensureShell();
const shell = fs.readFileSync(path.join(publicDirectory, ENTRY.slice(1)), "utf8");
// Root-only TanStack SPA state: no protected route SSR, user or cookies.
if (!shell.includes('lastMatchId:"__root__') || /access_token|refresh_token|cookies_enc/.test(shell)) throw new Error("Panel shell must be anonymous");
const paths = [ENTRY, "/favicon.ico", ...fs.readdirSync(path.join(publicDirectory, "assets")).filter(name => /\.(?:js|css|woff2?|png|svg|jpg|webp)$/.test(name)).map(name => "/assets/" + name)];
// TanStack uses pathe-relative POSIX filenames for its production IDs. Assert
// the real Windows/Linux client bundle still agrees with the server algorithm,
// rather than changing published RPC IDs or relying only on an offline UI test.
const clientCode = paths.filter(resource => resource.endsWith(".js")).map(resource => fs.readFileSync(path.join(publicDirectory, resource.slice(1)), "utf8")).join("\n");
for (const [module, name] of [["team", "listWorkspaces"], ["profiles", "listProfiles"], ["profiles", "saveProfile"], ["proxies", "listProxies"]]) {
  const id = sha256(`src/lib/${module}.functions.ts--${name}_createServerFn_handler`);
  if (!["\"", "'", "`"].some(quote => clientCode.includes(quote + id + quote))) throw new Error("Local panel RPC ID is incompatible: " + name);
}
const manifest = validateManifest({ schema: 1, entry: ENTRY, minimumDesktopVersion: require("../desktop/package.json").version, revision: new Date().toISOString(), files: paths.map(resource => {
  const bytes = fs.readFileSync(path.join(publicDirectory, resource.slice(1)));
  return { path: resource, size: bytes.length, sha256: sha256(bytes) };
}) });
fs.writeFileSync(path.join(publicDirectory, MANIFEST.slice(1)), JSON.stringify(manifest));
// Generated public build output only, never a user-data/session/cache directory.
// Prevent obsolete chunks (or unrelated files) accumulating in the installer.
if (path.dirname(desktopDirectory) !== path.join(root, "desktop") || path.basename(desktopDirectory) !== ".panel") throw new Error("Invalid generated panel output path");
if (fs.existsSync(desktopDirectory) && fs.lstatSync(desktopDirectory).isSymbolicLink()) throw new Error("Generated panel output must not be a symlink");
fs.rmSync(desktopDirectory, { recursive: true, force: true });
// Copy only explicit public resources. No server bundle, env files or source maps.
for (const file of [...manifest.files, { path: MANIFEST }]) {
  const target = path.join(desktopDirectory, file.path.slice(1));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(publicDirectory, file.path.slice(1)), target);
}
loadBundled(desktopDirectory);
console.log(`Verified anonymous local panel: ${manifest.files.length} public assets`);
})().catch(error => { console.error(error); process.exit(1); });
