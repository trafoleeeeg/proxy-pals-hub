const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createSessionOutbox(directory, protection) {
  const filename = (id) => {
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid snapshot ID");
    return path.join(directory, id + ".bin");
  };
  return {
    enqueue(payload) {
      if (!UUID.test(payload.profileId)) throw new Error("Invalid profile ID");
      if (!protection.isEncryptionAvailable()) throw new Error("Windows encryption is unavailable");
      const entry = { ...payload, snapshotId: randomUUID(), savedAt: new Date().toISOString() };
      const encrypted = protection.encryptString(JSON.stringify(entry));
      fs.mkdirSync(directory, { recursive: true });
      const target = filename(entry.snapshotId);
      fs.writeFileSync(target + ".tmp", encrypted, { mode: 0o600, flush: true });
      fs.renameSync(target + ".tmp", target);
      return entry;
    },
    list() {
      if (!fs.existsSync(directory)) return [];
      return fs.readdirSync(directory)
        .filter((name) => name.endsWith(".bin") && UUID.test(name.slice(0, -4)))
        .map((name) => {
          const entry = JSON.parse(protection.decryptString(fs.readFileSync(path.join(directory, name))));
          if (entry.snapshotId + ".bin" !== name || !UUID.test(entry.profileId)) throw new Error("Invalid saved session");
          return entry;
        })
        .sort((a, b) => a.savedAt.localeCompare(b.savedAt));
    },
    archive(id) {
      const active = filename(id);
      const archived = path.join(directory, "archived", path.basename(active));
      if (!fs.existsSync(active)) {
        if (fs.existsSync(archived)) return;
        throw new Error("Saved session not found");
      }
      fs.mkdirSync(path.dirname(archived), { recursive: true });
      // A same-volume rename removes the active record only once its encrypted
      // bytes are durable in the archive. Retrying an already archived ID is safe.
      fs.renameSync(active, archived);
    },
    acknowledge(id) { fs.rmSync(filename(id), { force: true }); },
  };
}
module.exports = { createSessionOutbox };
