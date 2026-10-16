// A panel close, hidden menu command or unclassified app.quit() must not
// silently terminate live profiles. Keep the decision separate from saving:
// cancelling must not close a tab, mutate cookies or enqueue a closure.
function createAppShutdown({ app, hasOpenProfiles, closeProfiles, confirmQuit,
  diagnose = () => {}, onComplete = () => {}, onError = () => {} }) {
  let operation = null;
  let quitting = false;
  let source = "unknown";
  const record = (phase, quitSource) => {
    try { diagnose("app-quit-request", { phase, quitSource }); } catch { /* Optional diagnostics. */ }
  };
  return {
    isClosing: () => operation !== null,
    isQuitting: () => quitting,
    requestQuit(nextSource) {
      if (operation || quitting) return;
      source = nextSource;
      app.quit();
    },
    beforeQuit(event) {
      if (quitting) return;
      event.preventDefault();
      if (operation) return;
      const quitSource = source;
      source = "unknown";
      record("begin", quitSource);
      operation = Promise.resolve().then(async () => {
        if (hasOpenProfiles()) {
          // Fail closed on a dismissed/unavailable confirmation dialog.
          if (await confirmQuit({ source: quitSource }) !== true) {
            record("cancelled", quitSource);
            return;
          }
        }
        record("ready", quitSource);
        await closeProfiles();
        onComplete();
        quitting = true;
        record("done", quitSource);
        app.quit();
      }).catch(error => {
        quitting = false;
        record("failed", quitSource);
        try { onError(error); } catch { /* Keep the application alive. */ }
      }).finally(() => { operation = null; });
    },
  };
}

module.exports = { createAppShutdown };
