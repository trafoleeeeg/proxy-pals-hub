const { randomUUID } = require("node:crypto");
const { tokens } = require("./theme.cjs");

// Use the same neutral sidebar token as the panel, including the first native frame.
const lightness = Number(tokens.match(/--sidebar:\s*oklch\(([\d.]+)\s+0\s+0\)/)?.[1]);
if (!Number.isFinite(lightness)) throw new Error("Neutral panel sidebar token is missing");
const linear = lightness ** 3;
const channel = Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055));
const panelBackground = `rgb(${channel}, ${channel}, ${channel})`;

function startupUrl() {
  // No account, folder names, profile data or credentials are cached in this shell.
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>Umbra</title><style>${tokens}
    *{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}
    body{display:flex;background:var(--sidebar);color:var(--foreground);font:14px 'Segoe UI',system-ui,sans-serif}
    aside{width:240px;padding:0 16px;flex-shrink:0}.brand{height:64px;display:flex;align-items:center;gap:10px;font-size:16px;font-weight:600}
    .logo{width:28px;height:28px;display:grid;place-items:center;background:var(--sidebar-accent);border-radius:8px;font-size:12px}
    .line{height:12px;border-radius:6px;background:var(--secondary);opacity:.65;width:112px;margin:26px 8px}
    main{flex:1;min-width:0;background:var(--background);border:1px solid var(--border);border-radius:16px;margin:8px 8px 8px 0;padding:24px}
    .heading{width:135px;height:24px;margin:5px 0 30px}.toolbar{display:flex;gap:12px}.toolbar .line{flex:1;height:44px;margin:0;width:auto}
    .search{height:44px;width:100%;margin:16px 0 26px}.rule{height:1px;background:var(--border)}
    .status{font-size:12px;color:var(--muted-foreground);margin-top:22px}
    @media(max-width:639px){aside{width:64px;padding:0 18px}.brand span:last-child,aside .line{display:none}main{padding:20px}}
    </style><body><aside aria-hidden="true"><div class="brand"><span class="logo">U</span><span>Umbra</span></div>
    <div class="line"></div><div class="line"></div><div class="line"></div></aside>
    <main aria-busy="true"><div aria-hidden="true"><div class="line heading"></div><div class="toolbar"><div class="line"></div><div class="line"></div><div class="line"></div></div><div class="line search"></div><div class="rule"></div></div>
    <p class="status" role="status">Подключаемся к панели…</p></main></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

function createPanelStartup({ WebContentsView, session }, window, {
  appUrl, version, prepare = Promise.resolve(), showError, isClosing = () => false,
  localPanel = () => false,
  schedule = setTimeout, cancel = clearTimeout, loadTimeout = 20_000, legacyTimeout = 10_000,
}) {
  const localSession = session.fromPartition(`panel-startup-${randomUUID()}`, { cache: false });
  localSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  localSession.setPermissionCheckHandler(() => false);
  localSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "file://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const overlay = new WebContentsView({ webPreferences: {
    session: localSession, contextIsolation: true, sandbox: true, nodeIntegration: false,
    javascript: false, webSecurity: true, devTools: false,
  } });
  // Electron clears View.webContents when it is destroyed. Retain the wrapper
  // for idempotent cleanup even if the owner window closes during preparation.
  const overlayContents = overlay.webContents;
  const panelContents = window.webContents;
  overlay.setBackgroundColor(panelBackground);
  overlayContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlayContents.on("will-navigate", event => event.preventDefault());
  overlayContents.on("will-attach-webview", event => event.preventDefault());
  window.contentView.addChildView(overlay);
  const fit = () => {
    if (!disposed && !window.isDestroyed()) {
      const { width, height } = window.getContentBounds();
      overlay.setBounds({ x: 0, y: 0, width, height });
    }
  };
  let disposed = false;
  let loaded = false;
  let ready = false;
  let loading;
  let legacyTimer;
  let deadline;
  // Removing a failed local paint must not cancel loading the real panel.
  const gone = () => window.isDestroyed() || isClosing();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancel(legacyTimer); cancel(deadline);
    window.removeListener("resize", fit);
    window.removeListener("closed", dispose);
    panelContents.removeListener("render-process-gone", reveal);
    if (!window.isDestroyed()) window.contentView.removeChildView(overlay);
    if (!overlayContents.isDestroyed()) overlayContents.close();
  };
  const reveal = () => {
    if (disposed || window.isDestroyed()) return;
    ready = true;
    dispose();
    panelContents.focus();
  };
  window.on("resize", fit);
  window.on("closed", dispose);
  panelContents.on("render-process-gone", reveal);
  fit();
  // Start local paint and network setup independently. Never navigate the main
  // webContents through a local splash before fetching the trusted panel.
  void overlayContents.loadURL(startupUrl()).catch(reveal);
  window.maximize();
  window.show();
  fit();

  async function load(attempt = 0) {
    if (gone()) return;
    const url = new URL(appUrl);
    url.searchParams.set("desktop", version);
    // A stable URL and normal HTTP validation reuse immutable hashed JS/CSS.
    // Auth remains server-verified; neither sessions nor permissions are cached here.
    try {
      let attemptDeadline;
      await new Promise((resolve, reject) => {
        attemptDeadline = deadline = schedule(() => {
          if (!panelContents.isDestroyed()) panelContents.stop();
          reject(new Error("Panel navigation timed out"));
        }, loadTimeout);
        window.loadURL(url.href).then(resolve, reject);
      }).finally(() => cancel(attemptDeadline));
      loaded = true;
      // A verified root-only local document is safe to show before network auth
      // completes hydration. Do not hold its first paint behind getUser().
      if (localPanel()) reveal();
      // Compatibility with panels predating the ready IPC and failed hydration.
      if (!ready && !disposed) legacyTimer = schedule(reveal, legacyTimeout);
    } catch {
      if (gone()) return;
      if (attempt < 2) return load(attempt + 1);
      const retry = await showError();
      if (!gone() && retry) return load();
      if (!gone()) window.close();
    }
  }
  return {
    ready: reveal,
    dispose,
    start() {
      // Repeated calls share one navigation, including all retry attempts.
      return loading ||= Promise.resolve(prepare).then(() => load());
    },
    state: () => ({ loaded, ready, disposed }),
  };
}

module.exports = { createPanelStartup, panelBackground, startupUrl };
