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
