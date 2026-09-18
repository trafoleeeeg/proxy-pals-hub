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
      const entries = [];
      for (const name of fs.readdirSync(directory).filter((value) => value.endsWith(".bin") && UUID.test(value.slice(0, -4)))) {
        const active = path.join(directory, name);
        try {
          const entry = JSON.parse(protection.decryptString(fs.readFileSync(active)));
          if (entry.snapshotId + ".bin" !== name || !UUID.test(entry.profileId)) throw new Error("Invalid saved session");
          entries.push(entry);
        } catch {
          // Keep unreadable encrypted bytes for manual recovery, but do not let
          // one damaged record block the complete application after an update.
          const quarantined = path.join(directory, "unreadable", name);
          fs.mkdirSync(path.dirname(quarantined), { recursive: true });
          if (!fs.existsSync(quarantined)) fs.renameSync(active, quarantined);
          else fs.rmSync(active, { force: true });
        }
      }
      return entries.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
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
