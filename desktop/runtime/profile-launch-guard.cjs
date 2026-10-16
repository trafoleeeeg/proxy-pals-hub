// A duplicate/reloaded panel can retry an ACK while its first disk write is
// still pending. The durable outbox alone is not a mutex: the first ACK (or an
// archive action) can remove its record before a second stale write finishes.
const acknowledgements = new WeakMap();
function acknowledgementState(outbox) {
  let state = acknowledgements.get(outbox);
  if (!state) {
    state = { profiles: new Map(), snapshots: new Map() };
    acknowledgements.set(outbox, state);
  }
  return state;
}

function assertNoPendingProfileClosure(outbox, id) {
  if (acknowledgements.get(outbox)?.profiles.has(id)) {
    throw new Error("Дождитесь завершения подтверждения cookies предыдущей сессии.");
  }
  let pending;
  try {
    pending = outbox.list();
    if (!Array.isArray(pending)) throw new Error();
  } catch {
    throw new Error("Не удалось проверить очередь сохранения cookies. Повторите синхронизацию перед запуском профиля.");
  }
  if (pending.some(entry => entry.profileId === id)) {
    throw new Error("Сначала сохраните предыдущую сессию профиля.");
  }
}
async function acknowledgeSavedClosure({ outbox, cookieStore, isRunning }, id) {
  const state = acknowledgementState(outbox);
  if (state.snapshots.has(id)) return state.snapshots.get(id);
  const entry = outbox.list().find(item => item.snapshotId === id);
  if (!entry) { outbox.acknowledge(id); return; }
  const profileId = entry.profileId;
  const previous = state.profiles.get(profileId) || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    // Re-read after the preceding ACK: an archived/already acknowledged record
    // must never authorize a stale write into the latest profile checkpoint.
    const current = outbox.list().find(item => item.snapshotId === id);
    if (!current) return;
    if (current.profileId !== profileId) throw new Error("Запись сохранения профиля изменилась. Повторите синхронизацию.");
    // Cleanup can still be taking its final snapshot. Also exclude an active
    // replacement session before the asynchronous checkpoint read/write.
    if (isRunning(profileId)) throw new Error("Дождитесь завершения закрытия профиля и повторите синхронизацию.");
    if (typeof current.cookies === "string" && current.cookiesUpdatedAt) {
      await cookieStore.acknowledgeClosed(profileId, current.cookies, current.cookiesUpdatedAt);
    }
    outbox.acknowledge(id);
  }).finally(() => {
    if (state.profiles.get(profileId) === task) state.profiles.delete(profileId);
    if (state.snapshots.get(id) === task) state.snapshots.delete(id);
  });
  // Register synchronously, before any await or disk I/O can allow a launch.
  state.profiles.set(profileId, task);
  state.snapshots.set(id, task);
  return task;
}
module.exports = { assertNoPendingProfileClosure, acknowledgeSavedClosure };
