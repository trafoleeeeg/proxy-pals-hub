const { BrowserWindow, session, app } = require("electron");
const path = require("node:path");

const open = new Map();

function proxyRules(proxy) {
  if (!proxy) return null;
  const scheme = proxy.protocol === "socks5" ? "socks5" : proxy.protocol === "https" ? "https" : "http";
  return `${scheme}://${proxy.host}:${proxy.port}`;
}

/** Восстанавливает cookies (сессии сайтов) профиля перед открытием окна. */
async function restoreCookies(ses, raw) {
  let list = [];
  try {
    list = JSON.parse(raw || "[]");
  } catch {
    return;
  }
  if (!Array.isArray(list)) return;
  for (const c of list) {
    if (!c || !c.name || !c.domain) continue;
    const domain = String(c.domain).replace(/^\./, "");
    const url = `${c.secure ? "https" : "http"}://${domain}${c.path || "/"}`;
    try {
      await ses.cookies.set({
        url,
        name: c.name,
        value: c.value ?? "",
        domain: c.domain,
        path: c.path || "/",
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      });
    } catch {
      /* пропускаем неподходящие cookie */
    }
  }
}

/** Снимает текущие cookies профиля, чтобы сохранить сессии в облаке команды. */
async function dumpCookies(ses) {
  try {
    const list = await ses.cookies.get({});
    return JSON.stringify(list);
  } catch {
    return null;
  }
}

/**
 * Запускает профиль в отдельном изолированном окне со своей сессией,
 * своим прокси и подменённым отпечатком.
 */
async function launchProfileWindow({ profileId, name, fingerprint, proxy, cookies }, onClosed) {
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

  await restoreCookies(ses, cookies);

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

  // Сохраняем сессии сайтов до закрытия окна, пока сессия ещё доступна.
  win.on("close", async () => {
    const dump = await dumpCookies(ses);
    if (typeof onClosed === "function") onClosed({ profileId, cookies: dump });
  });

  win.on("closed", () => open.delete(profileId));
  open.set(profileId, win);

  await win.loadURL(fp.start_url || "https://whoer.net");
}

/** Периодическое сохранение сессий открытого профиля. */
async function snapshotProfileCookies(profileId) {
  if (!open.has(profileId)) return null;
  return dumpCookies(session.fromPartition(`persist:profile-${profileId}`));
}

function closeProfileWindow(profileId) {
  const win = open.get(profileId);
  if (win && !win.isDestroyed()) win.close();
  open.delete(profileId);
}

module.exports = { launchProfileWindow, closeProfileWindow, snapshotProfileCookies };
