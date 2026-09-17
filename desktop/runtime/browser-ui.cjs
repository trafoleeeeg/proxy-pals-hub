const { createHash } = require("node:crypto");
const { renderHome, homeMarkup, homeStyle } = require("./profile-home.cjs");
const { tokens } = require("./theme.cjs");

function renderer() {
  const api = window.profileBrowser;
  const address = document.getElementById("address");
  const tabs = document.getElementById("tabs");
  const error = document.getElementById("error");
  const homeButton = document.createElement("button");
  homeButton.id = "go-home"; homeButton.type = "button"; homeButton.className = "icon";
  homeButton.textContent = "⌂"; homeButton.title = "Показатели профиля"; homeButton.setAttribute("aria-label", "Показатели профиля");
  address.before(homeButton);
  let current;
  const run = (command) => api.command(command).then((result) => {
    if (result?.error) error.textContent = result.error;
  }).catch(() => { error.textContent = "Browser command failed"; });
  document.getElementById("navigate").addEventListener("submit", (event) => {
    event.preventDefault(); address.blur(); run({ action: "navigate", value: address.value });
  });
  document.getElementById("home-search").addEventListener("submit", (event) => {
    event.preventDefault(); run({ action: "navigate", value: document.getElementById("home-address").value });
  });
  for (const action of ["back", "forward", "reload", "new", "home", "check-connection", "close-profile"]) {
    document.getElementById(action === "home" ? "go-home" : action).addEventListener("click", () => run({ action }));
  }
  address.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && current) { address.value = current.url; address.blur(); }
  });
  api.subscribe((state) => {
    if (state.focusAddress) { address.focus(); address.select(); return; }
    current = state.tabs.find((tab) => tab.id === state.activeId);
    document.getElementById("home").hidden = !state.home;
    renderHome(state.info);
    document.getElementById("profile").textContent = state.name;
    document.title = state.name + " - Umbra";
    if (document.activeElement !== address) address.value = current?.url === "about:blank" ? "" : current?.url || "";
    error.textContent = state.error || current?.error || "";
    document.getElementById("back").disabled = !current?.canGoBack;
    document.getElementById("forward").disabled = !current?.canGoForward;
    const reload = document.getElementById("reload");
    reload.textContent = current?.loading ? "\u00d7" : "\u21bb";
    reload.title = current?.loading ? "Остановить" : "Обновить";
    reload.setAttribute("aria-label", reload.title);
    const focusedTab = document.activeElement?.dataset?.focusKey;
    tabs.replaceChildren(...state.tabs.map((tab) => {
      const item = document.createElement("div"); item.className = "tab";
      const select = document.createElement("button");
      select.className = "tab-title"; select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(tab.id === state.activeId));
      select.dataset.focusKey = "tab-" + tab.id;
      select.textContent = tab.title || "Новая вкладка"; select.title = tab.title || tab.url;
      select.onclick = () => run({ action: "select", id: tab.id });
      const close = document.createElement("button"); close.textContent = "\u00d7";
      close.className = "tab-close"; close.title = "Закрыть вкладку"; close.setAttribute("aria-label", "Закрыть вкладку");
      close.dataset.focusKey = "close-" + tab.id;
      close.onclick = () => run({ action: "close-tab", id: tab.id });
      item.append(select, close); return item;
    }));
    if (focusedTab) [...tabs.querySelectorAll("button")].find((button) => button.dataset.focusKey === focusedTab)?.focus();
    document.getElementById("new").disabled = state.tabs.length >= 32;
  });
  run({ action: "state" });
}

function browserUrl() {
  // HTML parsing normalizes CRLF even when Git checks out this source with CRLF on Windows.
  const script = `${renderHome.toString()}\n(${renderer.toString()})();`.replace(/\r\n?/g, "\n");
  const hash = createHash("sha256").update(script).digest("base64");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'">
<title>Umbra</title><style>${tokens}${homeStyle}
*{box-sizing:border-box;letter-spacing:0}body{margin:0;background:#111217;color:#f1f2f5;font:13px system-ui,sans-serif;overflow:hidden}
button,input{font:inherit;color:inherit}button{border:0;border-radius:4px;background:transparent;cursor:pointer;height:30px;flex-shrink:0}button:hover{background:#34363f}button:disabled{opacity:.35;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #55c5ae;outline-offset:-2px}
#top{display:flex;gap:6px;align-items:center;height:40px;padding:4px 8px;background:#191b23}#profile{max-width:140px;min-width:50px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#7cdeca;padding:0 6px}#tabs{display:flex;gap:4px;overflow-x:auto;flex:1;min-width:0;height:34px;scrollbar-width:thin}.tab{display:flex;flex:0 0 180px;min-width:0;height:30px;background:#242630;border-radius:4px}.tab-title{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:left;padding:0 9px}.tab:has([aria-selected=true]){background:#3c404b;border-bottom:2px solid #55c5ae}.tab-close{width:28px;font-size:19px}
.icon{width:32px;font-size:20px}#navigate{display:flex;align-items:center;gap:6px;height:44px;margin:0;padding:6px 10px;border-bottom:1px solid #383a44}#address{min-width:0;width:100%;height:30px;background:#242630;border:1px solid #4d5160;border-radius:4px;padding:0 10px}#error{height:24px;color:#ffb4b4;padding:3px 12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}#new{font-size:22px}#close-profile{font-size:19px}
</style></head><body><div id="top"><span id="profile">Umbra</span><div id="tabs" role="tablist" aria-label="Tabs"></div><button id="new" class="icon" title="Новая вкладка" aria-label="Новая вкладка">+</button><button id="close-profile" class="icon" title="Закрыть профиль" aria-label="Закрыть профиль">&#9211;</button></div>
<form id="navigate"><button id="back" type="button" class="icon" title="Назад" aria-label="Назад">&#8592;</button><button id="forward" type="button" class="icon" title="Вперёд" aria-label="Вперёд">&#8594;</button><button id="reload" type="button" class="icon" title="Обновить" aria-label="Обновить">&#8635;</button><input id="address" type="text" aria-label="Адрес" placeholder="Поиск или адрес сайта" autocomplete="off" spellcheck="false"><button class="icon" type="submit" title="Перейти" aria-label="Перейти">&#8594;</button></form>
<div id="error" role="status" aria-live="polite"></div>${homeMarkup}<script>${script}</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = { browserUrl };
