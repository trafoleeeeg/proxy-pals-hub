const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

const REGISTRY = "extensions.json";

function createExtensionStore(getUserData) {
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
      return data.map(({ id }) => ({ id, path: directory(id) }));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("Не удалось прочитать набор расширений");
    }
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
          valid.push({ id: entry.id, name: manifest.name, version: manifest.version });
        }
      } catch { /* a removed folder is omitted from the UI */ }
    }
    return valid;
  }

  async function ids() {
    return (await read()).map((entry) => entry.id);
  }

  async function addFromDirectory(source) {
    const sourcePath = path.resolve(String(source || ""));
    const manifestPath = path.join(sourcePath, "manifest.json");
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
    catch { throw new Error("В выбранной папке нет корректного manifest.json"); }
    if (!manifest || typeof manifest.name !== "string" || typeof manifest.version !== "string" ||
      ![2, 3].includes(manifest.manifest_version)) {
      throw new Error("Поддерживаются распакованные расширения Manifest V2 или V3");
    }
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

  async function remove(id) {
    if (!/^[a-f0-9]{24}$/.test(String(id))) throw new Error("Некорректный идентификатор расширения");
    const entries = await read();
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    // Unregister and let the runtime unload it. Never delete code still in use.
    await write(entries.filter((item) => item.id !== id));
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
    remove: (id) => serialize(() => remove(id)),
    loadIntoSession: (ses, loaded) => serialize(() => loadIntoSession(ses, loaded)),
  };
}

module.exports = { createExtensionStore };
