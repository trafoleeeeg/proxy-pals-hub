// Runtime.evaluate without a context asks Blink to create the default world.
// On a provisional frame that path DCHECKs in our Chromium build. Only use a
// context which Runtime actually announced, and its process-unique identity.
function executionContexts({ timeout = 4000, onTrace = () => {} } = {}) {
  const sessions = new Map();
  const targetTypes = new Map();
  const closed = new Set();
  const pending = new Set();
  let disposed = false;
  const key = id => id || "";
  const trace = (phase, session, details = {}) => {
    try { onTrace({ phase, targetType: targetTypes.get(session) || "page", ...details }); } catch { /* Diagnostics cannot affect context selection. */ }
  };
  const find = (id, frameId) => [...(sessions.get(key(id))?.values() || [])]
    .reverse().find(context => !frameId || context.auxData?.frameId === frameId)?.uniqueId;
  function registerTarget(id, type) {
    if (!id || disposed || closed.has(key(id))) return;
    if (["worker", "page", "iframe"].includes(type)) targetTypes.set(key(id), type);
  }
  function update(method, params, id) {
    const session = key(id);
    if (disposed || closed.has(session)) return;
    if (method === "Runtime.executionContextCreated") {
      const context = params.context;
      const hasUniqueId = typeof context?.uniqueId === "string" && !!context.uniqueId;
      // Blink's WorkerThreadDebugger uses WorkerOptions.name as the context
      // name and does not add the page-specific auxData.isDefault flag. A
      // nonempty name is valid ONLY for a CDP-confirmed dedicated worker.
      // Never apply this exception to a page/frame or an isolated world.
      const worker = targetTypes.get(session) === "worker";
      const accepted = hasUniqueId && (context.auxData?.isDefault === true || (context.auxData?.isDefault === undefined &&
          (worker || context.name === "")));
      trace("created", session, { named: typeof context?.name === "string" && context.name.length > 0, hasUniqueId, accepted,
        ...(typeof context?.auxData?.isDefault === "boolean" ? { defaultWorld: context.auxData.isDefault } : {}) });
      if (!accepted) return;
      let contexts = sessions.get(session);
      if (!contexts) sessions.set(session, contexts = new Map());
      contexts.set(context.id, context);
    } else if (method === "Runtime.executionContextDestroyed") {
      trace("destroyed", session);
      const contexts = sessions.get(session);
      for (const [id, context] of contexts || []) {
        const matches = params.executionContextUniqueId
          ? context.uniqueId === params.executionContextUniqueId : id === params.executionContextId;
        if (matches) contexts.delete(id);
      }
    } else if (method === "Runtime.executionContextsCleared") { trace("cleared", session); sessions.delete(session); }
    else return;
    for (const waiter of [...pending]) {
      const uniqueId = find(waiter.id, waiter.frameId);
      if (uniqueId) waiter.finish(null, uniqueId);
    }
  }
  function close(id) {
    const session = key(id);
    trace("detached", session);
    closed.add(session);
    sessions.delete(session);
    targetTypes.delete(session);
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
    targetTypes.clear();
    closed.clear();
    for (const waiter of [...pending]) waiter.finish(new Error("Execution target detached"));
  }
  return { registerTarget, update, wait, close, dispose };
}

module.exports = { executionContexts };
