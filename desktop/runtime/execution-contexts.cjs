// Runtime.evaluate without a context asks Blink to create the default world.
// On a provisional frame that path DCHECKs in our Chromium build. Only use a
// context which Runtime actually announced, and its process-unique identity.
function executionContexts({ timeout = 4000 } = {}) {
  const sessions = new Map();
  const closed = new Set();
  const pending = new Set();
  let disposed = false;
  const key = id => id || "";
  const find = (id, frameId) => [...(sessions.get(key(id))?.values() || [])]
    .reverse().find(context => !frameId || context.auxData?.frameId === frameId)?.uniqueId;
  function update(method, params, id) {
    const session = key(id);
    if (disposed || closed.has(session)) return;
    if (method === "Runtime.executionContextCreated") {
      const context = params.context;
      if (!context?.uniqueId || (context.auxData?.isDefault !== true &&
          !(context.auxData?.isDefault === undefined && context.name === ""))) return;
      let contexts = sessions.get(session);
      if (!contexts) sessions.set(session, contexts = new Map());
      contexts.set(context.id, context);
    } else if (method === "Runtime.executionContextDestroyed") {
      const contexts = sessions.get(session);
      for (const [id, context] of contexts || []) {
        const matches = params.executionContextUniqueId
          ? context.uniqueId === params.executionContextUniqueId : id === params.executionContextId;
        if (matches) contexts.delete(id);
      }
    } else if (method === "Runtime.executionContextsCleared") sessions.delete(session);
    else return;
    for (const waiter of [...pending]) {
      const uniqueId = find(waiter.id, waiter.frameId);
      if (uniqueId) waiter.finish(null, uniqueId);
    }
  }
  function close(id) {
    const session = key(id);
    closed.add(session);
    sessions.delete(session);
    for (const waiter of [...pending]) if (key(waiter.id) === session) waiter.finish(new Error("Execution target detached"));
  }
  function wait(id, frameId) {
    if (disposed || closed.has(key(id))) return Promise.reject(new Error("Execution target detached"));
    const uniqueId = find(id, frameId);
    if (uniqueId) return Promise.resolve(uniqueId);
    return new Promise((resolve, reject) => {
      const waiter = { id, frameId, finish(error, value) {
        clearTimeout(timer); pending.delete(waiter);
        if (error) reject(error); else resolve(value);
      } };
      const timer = setTimeout(() => waiter.finish(new Error("Execution context unavailable")), timeout);
      timer.unref?.();
      pending.add(waiter);
    });
  }
  function dispose() {
    disposed = true;
    sessions.clear();
    closed.clear();
    for (const waiter of [...pending]) waiter.finish(new Error("Execution target detached"));
  }
  return { update, wait, close, dispose };
}

module.exports = { executionContexts };
