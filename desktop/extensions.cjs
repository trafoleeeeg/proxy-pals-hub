const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { unpackArchive } = require("./crx.cjs");
const { parseExtensionUrl, fetchBuffer } = require("./extension-source.cjs");

const REGISTRY = "extensions.json";

function createExtensionStore(getUserData, deps = {}) {
  const download = deps.fetchBuffer || fetchBuffer;
  const root = () => path.join(getUserData(), "extensions");
  const registryPath = () => path.join(getUserData(), REGISTRY);
  let queue = Promise.resolve();
  const directory = (id) => {
    if (!/^[a-f0-9]{24}$/.test(String(id))) throw new Error("Некорректный идентификатор расширения");
    const target = path.resolve(root(), id);
    if (path.dirname(target) !== path.resolve(root())) throw new Error("Некорректная папка расширения");
    return target;
  };
  async function checkTree(folder, budget = { entries: 0, bytes: 0 }) {
    if (++budget.entries > 20_000) throw new Error("Расширение слишком большое");
    const info = await fs.lstat(folder);
    if (info.isSymbolicLink()) throw new Error("Символические ссылки в расширениях не поддерживаются");
    if (info.isDirectory()) {
      for (const name of await fs.readdir(folder)) await checkTree(path.join(folder, name), budget);
    } else if (info.isFile()) {
      budget.bytes += info.size;
      if (budget.bytes > 200 * 1024 * 1024) throw new Error("Расширение слишком большое");
    } else throw new Error("Неподдерживаемый файл расширения");
  }

  async function read() {
    try {
      const data = JSON.parse(await fs.readFile(registryPath(), "utf8"));
      if (!Array.isArray(data) || data.some((entry) => !entry || !/^[a-f0-9]{24}$/.test(entry.id))) throw new Error();
      return data.map(({ id, source, pinned }) => ({ id, path: directory(id), source: normalizeSource(source), pinned: pinned === true }));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("Не удалось прочитать набор расширений");
    }
  }

  function normalizeSource(source) {
    if (!source || typeof source !== "object") return undefined;
    if (source.kind !== "store" && source.kind !== "url") return undefined;
    if (typeof source.downloadUrl !== "string" || !source.downloadUrl.startsWith("https://")) return undefined;
    return { kind: source.kind, downloadUrl: source.downloadUrl, pageUrl: typeof source.pageUrl === "string" ? source.pageUrl : source.downloadUrl };
  }

  async function write(entries) {
    await fs.mkdir(root(), { recursive: true });
    const temporary = registryPath() + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(temporary, registryPath());
  }

  async function list() {
    const entries = await read();
    const valid = [];
    for (const entry of entries) {
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(entry.path, "manifest.json"), "utf8"));
        if (manifest && typeof manifest.name === "string" && typeof manifest.version === "string") {
          const item = { id: entry.id, name: manifest.name, version: manifest.version };
          if (entry.pinned) item.pinned = true;
          const icons = manifest.icons && typeof manifest.icons === "object" ? Object.values(manifest.icons) : [];
          const icon = icons.map(String).at(-1);
          if (icon && !path.isAbsolute(icon) && !icon.split(/[\\/]/).includes("..")) {
            try {
              const iconFile = await fs.readFile(path.join(entry.path, icon));
              if (iconFile.length <= 256 * 1024) {
                const extension = path.extname(icon).toLowerCase();
                const type = extension === ".svg" ? "image/svg+xml" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
                item.icon = `data:${type};base64,${iconFile.toString("base64")}`;
              }
            } catch { /* icon is optional */ }
          }
          if (entry.source) { item.source = entry.source.kind; item.url = entry.source.pageUrl; }
          valid.push(item);
        }
      } catch { /* a removed folder is omitted from the UI */ }
    }
    return valid;
  }

  async function ids() {
    return (await read()).map((entry) => entry.id);
  }

  function readManifest(manifest) {
    if (!manifest || typeof manifest.name !== "string" || typeof manifest.version !== "string" ||
      ![2, 3].includes(manifest.manifest_version)) {
      throw new Error("Поддерживаются распакованные расширения Manifest V2 или V3");
    }
    return manifest;
  }

  async function loadManifest(folder) {
    try { return readManifest(JSON.parse(await fs.readFile(path.join(folder, "manifest.json"), "utf8"))); }
    catch (error) {
      if (error instanceof SyntaxError || error.code === "ENOENT") throw new Error("В расширении нет корректного manifest.json");
      throw error;
    }
  }

  async function addFromDirectory(source) {
    const sourcePath = path.resolve(String(source || ""));
    const manifestPath = path.join(sourcePath, "manifest.json");
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
    catch { throw new Error("В выбранной папке нет корректного manifest.json"); }
    readManifest(manifest);
    const id = createHash("sha256").update(sourcePath + "\0" + manifest.name + "\0" + manifest.version).digest("hex").slice(0, 24);
    const entries = await read();
    const managed = entries.find((entry) => entry.path.toLowerCase() === sourcePath.toLowerCase());
    if (managed) return { id: managed.id, name: manifest.name, version: manifest.version };
    if (entries.some((entry) => entry.id === id)) return { id, name: manifest.name, version: manifest.version };
    const relativeRoot = path.relative(sourcePath, path.resolve(root()));
    if (!relativeRoot || (!relativeRoot.startsWith("..") && !path.isAbsolute(relativeRoot))) throw new Error("Выберите только папку расширения");
    await checkTree(sourcePath);
    const destination = directory(id);
    await fs.mkdir(root(), { recursive: true });
    try { await fs.access(destination); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.cp(sourcePath, destination, { recursive: true, force: false, errorOnExist: true, dereference: false });
    }
    await checkTree(destination);
    const next = entries.filter((entry) => entry.id !== id);
    next.push({ id, path: destination });
    await write(next);
    return { id, name: manifest.name, version: manifest.version };
  }

  // Downloads an extension from the Chrome Web Store or a direct https link.
  async function installFromSource(parsed, forcedId) {
    const id = forcedId || createHash("sha256").update(parsed.key).digest("hex").slice(0, 24);
    const staging = path.join(os.tmpdir(), "umbra-extension-" + randomUUID());
    try {
      const archive = await download(parsed.downloadUrl);
      await unpackArchive(archive, staging);
      const manifest = await loadManifest(staging);
      await checkTree(staging);
      const destination = directory(id);
      await fs.mkdir(root(), { recursive: true });
      await fs.rm(destination, { recursive: true, force: true });
      await fs.cp(staging, destination, { recursive: true, dereference: false });
      const previous = (await read()).find((entry) => entry.id === id);
      const entries = (await read()).filter((entry) => entry.id !== id);
      entries.push({ id, source: { kind: parsed.kind, downloadUrl: parsed.downloadUrl, pageUrl: parsed.pageUrl }, pinned: previous?.pinned === true });
      await write(entries);
      return { id, name: manifest.name, version: manifest.version, source: parsed.kind, url: parsed.pageUrl };
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function addFromUrl(value) {
    return installFromSource(parseExtensionUrl(value));
  }

  async function updateFromSource(id) {
    const entry = (await read()).find((item) => item.id === String(id));
    if (!entry || !entry.source) throw new Error("Это расширение добавлено папкой, обновление по ссылке недоступно");
    return installFromSource(parseExtensionUrl(entry.source.pageUrl || entry.source.downloadUrl), entry.id);
  }

  async function remove(id) {
    if (!/^[a-f0-9]{24}$/.test(String(id))) throw new Error("Некорректный идентификатор расширения");
    const entries = await read();
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    // Unregister and let the runtime unload it. Never delete code still in use.
    await write(entries.filter((item) => item.id !== id));
  }

  async function setPinned(id, pinned) {
    if (!/^[a-f0-9]{24}$/.test(String(id))) throw new Error("Некорректный идентификатор расширения");
    const entries = await read();
    if (!entries.some((item) => item.id === id)) return false;
    await write(entries.map((item) => item.id === id ? { ...item, pinned: pinned === true } : item));
    return pinned === true;
  }

  async function loadIntoSession(ses, loaded = new Map()) {
    const entries = await read();
    const errors = [];
    const api = ses.extensions || ses;
    for (const [id, extensionId] of loaded) {
      if (!entries.some((entry) => entry.id === id)) {
        try { api.removeExtension(extensionId); loaded.delete(id); }
        catch { errors.push(id); }
      }
    }
    for (const entry of entries) {
      if (loaded.has(entry.id)) continue;
      try {
        await checkTree(entry.path);
        const extension = await api.loadExtension(entry.path, { allowFileAccess: false });
        loaded.set(entry.id, extension.id);
      } catch { errors.push(entry.id); }
    }
    return { loaded: [...loaded.keys()], errors };
  }

  function serialize(task) {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  }

  return {
    list: () => serialize(list),
    ids: () => serialize(ids),
    addFromDirectory: (source) => serialize(() => addFromDirectory(source)),
    addFromUrl: (url) => serialize(() => addFromUrl(url)),
    update: (id) => serialize(() => updateFromSource(id)),
    remove: (id) => serialize(() => remove(id)),
    setPinned: (id, pinned) => serialize(() => setPinned(id, pinned)),
    loadIntoSession: (ses, loaded) => serialize(() => loadIntoSession(ses, loaded)),
  };
}

module.exports = { createExtensionStore };
