function createUpdateController({ updater, enabled, currentVersion, onState, hasOpenProfiles }) {
  let state = { state: "none" };
  let checking = null;
  let downloading = null;
  let installing = false;
  const listeners = [];
  const setState = (next) => { state = next; onState(next); };
  const on = (event, listener) => {
    updater.on(event, listener);
    listeners.push([event, listener]);
  };
  const errorText = (error) => String(error?.message || error).slice(0, 600);
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  on("checking-for-update", () => setState({ state: "checking" }));
  on("update-available", (info) => setState({ state: "downloading", version: info.version, percent: 0 }));
  on("update-not-available", () => setState({ state: "none" }));
  on("download-progress", (info) => setState({
    state: "downloading", version: state.version,
    percent: Math.max(0, Math.min(100, Math.round(info.percent || 0))),
  }));
  on("update-downloaded", (info) => setState({ state: "downloaded", version: info.version }));
  on("error", (error) => {
    if (installing || state.state !== "downloaded") {
      installing = false;
      setState({ state: "error", error: errorText(error) });
    }
  });

  async function check() {
    if (!enabled) return { ok: false, error: "Обновления доступны в установленном приложении Windows" };
    if (state.state === "downloaded" || state.state === "downloading") {
      return { ok: true, current: currentVersion, version: state.version };
    }
    if (checking) return checking;
    checking = (async () => {
      try {
        const result = await updater.checkForUpdates();
        if (result?.downloadPromise) {
          void result.downloadPromise.catch((error) => {
            if (state.state !== "downloaded") setState({ state: "error", error: errorText(error) });
          });
        }
        return { ok: true, current: currentVersion, version: result?.updateInfo?.version || null };
      } catch (error) {
        const message = errorText(error);
        setState({ state: "error", error: message });
        return { ok: false, error: message };
      } finally { checking = null; }
    })();
    return checking;
  }
  async function download() {
    if (!enabled) return { ok: false, error: "Обновления доступны в установленном приложении Windows" };
    if (state.state === "downloaded") return { ok: true };
    if (downloading) return downloading;
    if (state.state === "downloading") return { ok: true };
    if (state.state !== "available") return check();
    downloading = updater.downloadUpdate().then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, error: errorText(error) }))
      .finally(() => { downloading = null; });
    return downloading;
  }
  function install() {
    if (!enabled || state.state !== "downloaded") return { ok: false, error: "Обновление ещё не загружено" };
    if (hasOpenProfiles()) return { ok: false, error: "Закройте запущенные профили перед установкой обновления" };
    if (installing) return { ok: true };
    installing = true;
    setImmediate(() => {
      try {
        if (hasOpenProfiles()) throw new Error("Закройте запущенные профили перед установкой обновления");
        updater.quitAndInstall(true, true);
      }
      catch (error) {
        installing = false;
        setState({ state: "error", error: errorText(error) });
      }
    });
    return { ok: true };
  }
  return {
    getState: () => state, isInstalling: () => installing, check, download, install,
    dispose: () => listeners.forEach(([event, listener]) => updater.removeListener(event, listener)),
  };
}

module.exports = { createUpdateController };
