const fs = require("node:fs");
const path = require("node:path");
const { ENTRY, MANIFEST, sha256, validateManifest, loadBundled } = require("../desktop/runtime/panel-bundle.cjs");

const root = path.resolve(__dirname, "..");
const publicDirectory = path.join(root, ".output/public");
const desktopDirectory = path.join(root, "desktop/.panel");
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
  if (!clientCode.includes('"' + id + '"')) throw new Error("Local panel RPC ID is incompatible: " + name);
}
const manifest = validateManifest({ schema: 1, entry: ENTRY, minimumDesktopVersion: require("../desktop/package.json").version, revision: new Date().toISOString(), files: paths.map(resource => {
  const bytes = fs.readFileSync(path.join(publicDirectory, resource.slice(1)));
  return { path: resource, size: bytes.length, sha256: sha256(bytes) };
}) });
fs.writeFileSync(path.join(publicDirectory, MANIFEST.slice(1)), JSON.stringify(manifest));
// Copy only explicit public resources. No server bundle, env files or source maps.
for (const file of [...manifest.files, { path: MANIFEST }]) {
  const target = path.join(desktopDirectory, file.path.slice(1));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(publicDirectory, file.path.slice(1)), target);
}
loadBundled(desktopDirectory);
console.log(`Verified anonymous local panel: ${manifest.files.length} public assets`);
