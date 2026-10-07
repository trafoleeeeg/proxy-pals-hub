const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { fetchPanelResponse } = require("./panel-network.cjs");

const ENTRY = "/_umbra-panel.html";
const MANIFEST = "/umbra-panel.json";
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_MANIFEST = 128 * 1024;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const versionNumber = value => {
  if (typeof value !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value)) throw new Error("Invalid panel desktop version");
  const [major, minor, patch] = value.split(".").map(Number);
  return major * 100_000_000 + minor * 10_000 + patch;
};
const assetPath = value => typeof value === "string" && (value === ENTRY || value === "/favicon.ico" || /^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css|woff2?|png|svg|jpg|webp)$/.test(value));
const mimeTypes = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  ico: "image/x-icon", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", webp: "image/webp", woff: "font/woff", woff2: "font/woff2" };

function validateManifest(value, minimumRevision = "", desktopVersion) {
  if (!value || value.schema !== 1 || value.entry !== ENTRY || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value.revision)
    || value.revision < minimumRevision || !Array.isArray(value.files) || value.files.length < 2 || value.files.length > 256) throw new Error("Invalid panel manifest");
  const minimumDesktop = versionNumber(value.minimumDesktopVersion);
  if (desktopVersion && versionNumber(desktopVersion) < minimumDesktop) throw new Error("Panel requires a newer desktop client");
  const names = new Set();
  let total = 0;
  for (const file of value.files) {
    if (!assetPath(file.path) || names.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 1
      || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid panel asset");
    names.add(file.path); total += file.size;
  }
  if (!names.has(ENTRY) || total > MAX_TOTAL) throw new Error("Invalid panel bundle size");
  return value;
}

function loadBundle(directory, manifest) {
  const bytes = new Map();
  // Verify the entire generation before serving any of its code. No partial cache.
  for (const file of validateManifest(manifest).files) {
    const target = path.join(directory, file.path.slice(1));
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== file.size) throw new Error("Invalid panel asset file");
    const data = fs.readFileSync(target);
    if (data.length !== file.size || sha256(data) !== file.sha256) throw new Error("Panel asset integrity failure");
    bytes.set(file.path, data);
  }
  return { manifest, bytes };
}

function loadBundled(directory) {
  const target = path.join(directory, MANIFEST.slice(1));
  if (fs.statSync(target).size > MAX_MANIFEST) throw new Error("Panel manifest too large");
  return loadBundle(directory, JSON.parse(fs.readFileSync(target, "utf8")));
}

async function readBounded(response, limit) {
  if (!response.ok) throw new Error("Panel download failed");
  if (Number(response.headers.get("content-length")) > limit) throw new Error("Panel download too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Panel download is empty");
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Panel download too large");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

function createPanelBundle({ panelSession, origin, bundledDirectory, cacheDirectory, safeStorage, desktopVersion = require("../package.json").version }) {
  if (new URL(origin).protocol !== "https:") throw new Error("Local panel requires HTTPS origin");
  const bundled = loadBundled(bundledDirectory);
  validateManifest(bundled.manifest, "", desktopVersion);
  let selected = bundled;
  const protectedCache = safeStorage?.isEncryptionAvailable?.() && safeStorage.getSelectedStorageBackend?.() !== "basic_text";
  const pointer = path.join(cacheDirectory, "active.enc");
  if (protectedCache) {
    try {
      if (fs.statSync(pointer).size > MAX_MANIFEST * 2) throw new Error("Invalid cache pointer");
      const metadata = JSON.parse(safeStorage.decryptString(fs.readFileSync(pointer)));
      if (!/^[a-f0-9-]{36}$/.test(metadata.generation)) throw new Error("Invalid cache generation");
      validateManifest(metadata.manifest, bundled.manifest.revision, desktopVersion);
      selected = loadBundle(path.join(cacheDirectory, metadata.generation), metadata.manifest);
    } catch { /* Missing, old or damaged cache: use verified installer assets. */ }
  }
  const fetchNetwork = (request, options = {}) => panelSession.fetch(request, { ...options, bypassCustomProtocolHandlers: true });
  const handler = async request => {
    const url = new URL(request.url);
    let resource = url.pathname;
    if (url.origin === origin && request.method === "GET") {
      if ((resource === "/app" || resource.startsWith("/app/") || resource === "/auth")
        && request.headers.get("accept")?.includes("text/html")) resource = ENTRY;
      const bytes = selected.bytes.get(resource);
      if (bytes) return new Response(bytes, { headers: {
        "Content-Type": mimeTypes[path.extname(resource).slice(1)] || "application/octet-stream",
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      } });
      // Never substitute a different generation for a missing hashed chunk.
      if (resource.startsWith("/assets/")) return new Response(null, { status: 404 });
    }
    // Chromium supplies Origin/Fetch Metadata later in the normal network
    // path. protocol.handle runs before that: forwarding with net.fetch loses
    // them. Restore same-origin RPC metadata only after proving the renderer's
    // native initiator supplied by our pinned engine. Referrer alone is not
    // proof: an opaque sandboxed iframe can have a same-origin parent referrer.
    // Never turn an opaque/cross-origin request into a trusted panel request.
    if (url.origin === origin && resource.startsWith("/_serverFn/")) {
      const trusted = Object.hasOwn(request, "initiatorOrigin") && request.initiatorOrigin === origin;
      if (!trusted) return new Response("Forbidden", { status: 403 });
      const headers = new Headers(request.headers);
      if (!headers.has("Origin")) headers.set("Origin", origin);
      if (!headers.has("Sec-Fetch-Site")) headers.set("Sec-Fetch-Site", "same-origin");
      if (!headers.has("Referer") && request.referrer) headers.set("Referer", request.referrer);
      return fetchPanelResponse(fetchNetwork, request, { headers });
    }
    // POST/RPC/auth, other origins and profile sessions never use this cache.
    return fetchNetwork(request);
  };
  panelSession.protocol.handle("https", handler);

  let updating;
  async function update() {
    if (!protectedCache) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let staging;
    try {
      const download = async (resource, limit) => readBounded(await fetchNetwork(origin + resource, {
        signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store",
      }), limit);
      const manifest = validateManifest(JSON.parse((await download(MANIFEST, MAX_MANIFEST)).toString("utf8")), selected.manifest.revision, desktopVersion);
      if (manifest.revision === selected.manifest.revision) return false;
      const generation = randomUUID();
      staging = path.join(cacheDirectory, generation);
      fs.mkdirSync(staging, { recursive: true });
      // Bounded parallel downloads; no account/session headers or API results.
      let cursor = 0;
      const results = await Promise.allSettled(Array.from({ length: 4 }, async () => {
        try {
          while (cursor < manifest.files.length) {
            const file = manifest.files[cursor++];
            const bytes = await download(file.path, file.size);
            if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error("Downloaded panel asset integrity failure");
            const target = path.join(staging, file.path.slice(1));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, bytes, { flag: "wx" });
          }
        } catch (error) { controller.abort(); throw error; }
      }));
      if (results.some(result => result.status === "rejected")) throw new Error("Incomplete panel download");
      loadBundle(staging, manifest);
      const temp = pointer + "." + generation;
      const fd = fs.openSync(temp, "wx");
      try { fs.writeFileSync(fd, safeStorage.encryptString(JSON.stringify({ generation, manifest }))); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, pointer);
      // Keep `selected` immutable for the current process, including reloads.
      return true;
    } catch {
      controller.abort();
      // Only the UUID directory created by this invocation, within this cache.
      try {
        if (staging && path.dirname(staging) === path.resolve(cacheDirectory)) fs.rmSync(staging, { recursive: true, force: true });
      } catch { /* Incomplete UUID directories are never activated. */ }
      return false; // Failed download never touches the current generation.
    } finally { clearTimeout(timer); }
  }
  return { revision: selected.manifest.revision, handler, update: () => updating ||= update() };
}

module.exports = { ENTRY, MANIFEST, MAX_TOTAL, sha256, validateManifest, loadBundled, createPanelBundle };
