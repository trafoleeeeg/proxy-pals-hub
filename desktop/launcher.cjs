const { BrowserWindow, session, app } = require("electron");
const path = require("node:path");

const open = new Map();

function proxyRules(proxy) {
  if (!proxy) return null;
  const scheme = proxy.protocol === "socks5" ? "socks5" : proxy.protocol === "https" ? "https" : "http";
  return `${scheme}://${proxy.host}:${proxy.port}`;
}

/**
 * Запускает профиль в отдельном изолированном окне со своей сессией,
 * своим прокси и подменённым отпечатком.
 */
async function launchProfileWindow({ profileId, name, fingerprint, proxy }) {
  if (open.has(profileId)) {
    open.get(profileId).focus();
    return;
  }

  const partition = `persist:profile-${profileId}`;
  const ses = session.fromPartition(partition);

  const rules = proxyRules(proxy);
  if (rules) {
    await ses.setProxy({ proxyRules: rules, proxyBypassRules: "<local>" });
  }

  if (proxy && proxy.username) {
    app.on("login", (event, _wc, _req, authInfo, callback) => {
      if (authInfo.isProxy) {
        event.preventDefault();
        callback(proxy.username, proxy.password || "");
      }
    });
  }

  const fp = fingerprint || {};
  const win = new BrowserWindow({
    width: fp.screen_width ? Math.min(fp.screen_width, 1600) : 1280,
    height: fp.screen_height ? Math.min(fp.screen_height, 1000) : 800,
    title: name || "Профиль",
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "fingerprint-preload.cjs"),
      additionalArguments: [`--umbra-fingerprint=${encodeURIComponent(JSON.stringify(fp))}`],
    },
  });

  if (fp.user_agent) {
    win.webContents.setUserAgent(fp.user_agent);
    ses.setUserAgent(fp.user_agent, fp.languages ? fp.languages.join(",") : undefined);
  }

  win.on("closed", () => open.delete(profileId));
  open.set(profileId, win);

  await win.loadURL(fp.start_url || "https://whoer.net");
}

function closeProfileWindow(profileId) {
  const win = open.get(profileId);
  if (win && !win.isDestroyed()) win.close();
  open.delete(profileId);
}

module.exports = { launchProfileWindow, closeProfileWindow };
