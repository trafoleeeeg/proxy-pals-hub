const { createHash } = require("node:crypto");
const { renderHome, homeMarkup, homeStyle } = require("./profile-home.cjs");
const { tokens } = require("./theme.cjs");

function renderer() {
  const api = window.profileBrowser;
  const byId = (id) => document.getElementById(id);
  const address = byId("address");
  const tabs = byId("tabs");
  const error = byId("error");
  const bookmarksBar = byId("bookmarks-bar");
  const bookmarkPopover = byId("bookmark-popover");
  const extensionsPopover = byId("extensions-popover");
  const menu = byId("browser-menu");
  const newTab = byId("new");
  let current;
  let latestState = {};
  let draggedTab;
  let draggedBookmark;
  let sentChromeHeight;
  const icon = (name) => {
    const paths = {
      globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
      close: '<path d="m7 7 10 10M17 7 7 17"/>',
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.globe}</svg>`;
  };
  const run = (command) => api.command(command).then((result) => {
    if (result?.error) showError(result.error);
  }).catch(() => showError("Не удалось выполнить действие"));
  const closePopovers = (except) => {
    for (const popover of [bookmarkPopover, extensionsPopover, menu]) if (popover !== except) popover.hidden = true;
  };
  const togglePopover = (popover, anchor) => {
    const show = popover.hidden;
    closePopovers(popover);
    popover.hidden = !show;
    if (show) {
      const rect = anchor.getBoundingClientRect();
      popover.style.right = Math.max(8, innerWidth - rect.right) + "px";
      popover.style.top = byId("chrome").offsetHeight + 6 + "px";
      popover.querySelector("input,button")?.focus();
    }
  };
  let errorTimer;
  function showError(message) {
    clearTimeout(errorTimer);
    error.textContent = message || "";
    error.hidden = !message;
    if (message) errorTimer = setTimeout(() => { error.hidden = true; }, 6000);
  }
  function syncHeight() {
    const height = byId("chrome").offsetHeight;
    document.documentElement.style.setProperty("--chrome-height", height + "px");
    if (height === sentChromeHeight) return;
    sentChromeHeight = height;
    void run({ action: "chrome-height", value: height });
  }
  byId("navigate").addEventListener("submit", (event) => {
    event.preventDefault(); address.blur(); void run({ action: "navigate", value: address.value });
  });
  byId("home-search").addEventListener("submit", (event) => {
    event.preventDefault(); void run({ action: "navigate", value: byId("home-address").value });
  });
  for (const action of ["back", "forward", "reload", "new", "home", "close-profile"]) {
    byId(action).addEventListener("click", () => void run({ action }));
  }
  byId("star").addEventListener("click", () => {
    const saved = (latestState.bookmarks || []).find((item) => item.url === current?.url);
    byId("bookmark-title").value = saved?.title || current?.title || "";
    byId("bookmark-remove").hidden = !saved;
    togglePopover(bookmarkPopover, byId("star"));
  });
  byId("bookmark-save").addEventListener("click", () => { bookmarkPopover.hidden = true; void run({ action: "save-bookmark", title: byId("bookmark-title").value }); });
  byId("bookmark-remove").addEventListener("click", () => {
    const saved = (latestState.bookmarks || []).find((item) => item.url === current?.url);
    bookmarkPopover.hidden = true;
    if (saved) void run({ action: "remove-bookmark", id: saved.id });
  });
  byId("extensions").addEventListener("click", () => togglePopover(extensionsPopover, byId("extensions")));
  byId("menu-button").addEventListener("click", () => togglePopover(menu, byId("menu-button")));
  menu.addEventListener("click", (event) => {
    const action = event.target.closest("button")?.dataset.action;
    if (!action) return;
    menu.hidden = true;
    void run({ action });
  });
  byId("manage-extensions").addEventListener("click", () => { extensionsPopover.hidden = true; void run({ action: "manage-extensions" }); });
  address.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && current) { address.value = current.url === "about:blank" ? "" : current.url; address.blur(); }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".popover,.toolbar-button")) closePopovers();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePopovers();
  });
  api.subscribe((state) => {
    if (state.focusAddress) { address.focus(); address.select(); return; }
    latestState = state;
    current = state.tabs.find((tab) => tab.id === state.activeId);
    byId("home").hidden = !state.home;
    renderHome(state.info);
    byId("profile").textContent = state.name;
    document.title = state.name + " — Umbra";
    if (document.activeElement !== address) address.value = current?.url === "about:blank" ? "" : current?.url || "";
    showError(state.error || current?.error || "");
    byId("back").disabled = !current?.canGoBack;
    byId("forward").disabled = !current?.canGoForward;
    const reload = byId("reload");
    reload.classList.toggle("loading", !!current?.loading);
    reload.title = current?.loading ? "Остановить загрузку" : "Обновить страницу";
    reload.setAttribute("aria-label", reload.title);
    byId("star").classList.toggle("on", !!state.bookmarked);
    byId("restore-menu").disabled = !state.canRestoreTab;
    const focused = document.activeElement?.dataset?.focusKey;
    tabs.replaceChildren(...state.tabs.map((tab) => {
      const item = document.createElement("div");
      item.className = "tab"; item.dataset.id = tab.id; item.draggable = true;
      const select = document.createElement("button");
      select.className = "tab-title"; select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(tab.id === state.activeId));
      select.dataset.focusKey = "tab-" + tab.id;
      const favicon = document.createElement(tab.favicon ? "img" : "span");
      favicon.className = "favicon";
      if (tab.favicon) { favicon.src = tab.favicon; favicon.alt = ""; }
      else favicon.innerHTML = icon("globe");
      const label = document.createElement("span"); label.className = "tab-label"; label.textContent = tab.title || "Новая вкладка";
      select.append(favicon, label); select.title = tab.title || tab.url;
      select.onclick = () => void run({ action: "select", id: tab.id });
      select.onauxclick = (event) => { if (event.button === 1) void run({ action: "close-tab", id: tab.id }); };
      const close = document.createElement("button"); close.innerHTML = icon("close");
      close.className = "tab-close"; close.title = "Закрыть вкладку"; close.setAttribute("aria-label", "Закрыть вкладку");
      close.dataset.focusKey = "close-" + tab.id;
      close.onclick = () => void run({ action: "close-tab", id: tab.id });
      item.addEventListener("dragstart", () => { draggedTab = tab.id; item.classList.add("dragging"); });
      item.addEventListener("dragend", () => { draggedTab = undefined; item.classList.remove("dragging"); });
      item.addEventListener("dragover", (event) => event.preventDefault());
      item.addEventListener("drop", (event) => {
        event.preventDefault();
        if (!draggedTab || draggedTab === tab.id) return;
        const ids = state.tabs.map((entry) => entry.id);
        const from = ids.indexOf(draggedTab); const to = ids.indexOf(tab.id);
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        void run({ action: "reorder-tabs", ids });
      });
      item.append(select, close); return item;
    }));
    if (focused) [...document.querySelectorAll("[data-focus-key]")].find((button) => button.dataset.focusKey === focused)?.focus();
    newTab.disabled = state.tabs.length >= 32;
    bookmarksBar.hidden = !state.bookmarkBarVisible;
    bookmarksBar.replaceChildren(...(state.bookmarks || []).map((bookmark) => {
      const button = document.createElement("button"); button.className = "bookmark"; button.draggable = true; button.dataset.id = bookmark.id;
      const favicon = document.createElement(bookmark.favicon ? "img" : "div"); favicon.className = "bookmark-favicon";
      if (bookmark.favicon) { favicon.src = bookmark.favicon; favicon.alt = ""; } else favicon.innerHTML = icon("globe");
      const label = document.createElement("span"); label.textContent = bookmark.title || new URL(bookmark.url).hostname;
      button.append(favicon, label);
      button.title = bookmark.url; button.onclick = () => void run({ action: "open-bookmark", id: bookmark.id });
      button.onauxclick = (event) => { if (event.button === 1) void run({ action: "open-bookmark", id: bookmark.id, newTab: true }); };
      button.addEventListener("dragstart", () => { draggedBookmark = bookmark.id; });
      button.addEventListener("dragover", (event) => event.preventDefault());
      button.addEventListener("drop", (event) => {
        event.preventDefault(); if (!draggedBookmark || draggedBookmark === bookmark.id) return;
        const ids = state.bookmarks.map((entry) => entry.id); const from = ids.indexOf(draggedBookmark); const to = ids.indexOf(bookmark.id);
        ids.splice(to, 0, ids.splice(from, 1)[0]); void run({ action: "reorder-bookmarks", ids });
      });
      return button;
    }));
    const extensions = state.extensions || [];
    byId("extensions-count").textContent = extensions.length ? String(extensions.length) : "";
    const list = byId("extensions-list");
    list.replaceChildren(...extensions.map((extension) => {
      const row = document.createElement("div"); row.className = "extension-row";
      const image = document.createElement(extension.icon ? "img" : "span"); image.className = "extension-icon";
      if (extension.icon) { image.src = extension.icon; image.alt = ""; } else image.innerHTML = icon("globe");
      const text = document.createElement("div"); const title = document.createElement("strong"); title.textContent = extension.name;
      const meta = document.createElement("small"); meta.textContent = `Версия ${extension.version} · ${extension.enabled === false ? "отключено" : "включено"}`;
      text.append(title, meta); row.append(image, text); return row;
    }));
    byId("extensions-empty").hidden = extensions.length > 0;
    syncHeight();
  });
  void run({ action: "state" });
}

function browserUrl() {
  const script = `${renderHome.toString()}\n(${renderer.toString()})();`.replace(/\r\n?/g, "\n");
  const hash = createHash("sha256").update(script).digest("base64");
  const svg = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
  const back = svg('<path d="m15 18-6-6 6-6"/>');
  const forward = svg('<path d="m9 18 6-6-6-6"/>');
  const reload = svg('<path class="reload-path" d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/><path class="stop-path" d="M8 8h8v8H8z"/>');
  const home = svg('<path d="m3 11 9-8 9 8M5 10v10h14V10M9 20v-6h6v6"/>');
  const star = svg('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>');
  const puzzle = svg('<path d="M8 3h3a2 2 0 1 1 4 0h3v5h3a2 2 0 1 1 0 4h-3v6h-5v3a2 2 0 1 1-4 0v-3H3v-5h3a2 2 0 1 0 0-4H3V3z"/>');
  const menuIcon = svg('<circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/>');
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'">
<title>Umbra</title><style>${tokens}${homeStyle}
*{box-sizing:border-box;letter-spacing:0}html{--chrome-height:90px}body{margin:0;background:var(--background);color:var(--foreground);font:13px system-ui,sans-serif;overflow:hidden}button,input{font:inherit;color:inherit}button{border:0;background:transparent;cursor:pointer}button:disabled{opacity:.35;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid var(--ring);outline-offset:1px}svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}#chrome{position:relative;z-index:5;background:var(--sidebar);box-shadow:0 1px 0 var(--border)}
#tab-strip{display:flex;align-items:end;height:40px;padding:7px 8px 0;gap:4px;background:var(--sidebar)}#profile{flex:0 1 126px;min-width:44px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--primary);padding:0 8px 9px;font-weight:600}#tabs{display:flex;flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;gap:2px}#tabs::-webkit-scrollbar{display:none}.tab{display:flex;position:relative;flex:1 1 220px;min-width:74px;max-width:240px;height:33px;border-radius:9px 9px 0 0;color:var(--muted-foreground)}.tab:hover{background:color-mix(in oklab,var(--secondary) 72%,transparent)}.tab:has([aria-selected=true]){background:var(--secondary);color:var(--foreground)}.tab.dragging{opacity:.5}.tab-title{display:flex;align-items:center;gap:8px;min-width:0;flex:1;padding:0 4px 0 11px;text-align:left}.tab-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.favicon,.extension-icon{display:grid;place-items:center;width:16px;height:16px;flex:none}.favicon svg,.extension-icon svg{width:15px;height:15px}.tab-close{display:grid;place-items:center;width:28px;height:28px;margin:2px 3px 0 0;border-radius:50%;flex:none}.tab-close:hover,.toolbar-button:hover{background:var(--accent)}.tab-close svg{width:14px;height:14px}#new{margin:0 4px 3px;width:30px;height:30px;font-size:24px;border-radius:50%}
#navigate{display:flex;align-items:center;gap:5px;height:50px;margin:0;padding:7px 9px;background:var(--secondary)}.toolbar-button{position:relative;display:grid;place-items:center;width:34px;height:34px;border-radius:50%;flex:none}.address-wrap{display:flex;align-items:center;min-width:120px;flex:1;height:36px;padding:0 5px 0 13px;border:1px solid transparent;border-radius:18px;background:var(--background)}.address-wrap:focus-within{border-color:var(--ring);box-shadow:0 0 0 1px var(--ring)}#address{min-width:0;flex:1;height:32px;border:0;outline:0;background:transparent}.reload-path{display:block}.stop-path{display:none}.loading .reload-path{display:none}.loading .stop-path{display:block}#star.on svg{fill:var(--primary);stroke:var(--primary)}#extensions-count{position:absolute;right:1px;bottom:1px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--primary);color:var(--primary-foreground);font-size:9px;line-height:14px}#extensions-count:empty{display:none}
#bookmarks-bar{display:flex;align-items:center;gap:4px;height:34px;padding:4px 10px;background:var(--secondary);border-top:1px solid var(--border);overflow-x:auto;scrollbar-width:thin}#bookmarks-bar[hidden]{display:none}.bookmark{display:flex;align-items:center;gap:7px;flex:none;max-width:190px;height:26px;padding:0 8px;border-radius:5px}.bookmark:hover{background:var(--accent)}.bookmark-favicon{display:grid;place-items:center;width:16px;height:16px;flex:none;object-fit:contain}.bookmark-favicon svg{width:15px;height:15px}.bookmark span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.popover{position:fixed;top:88px;z-index:20;width:310px;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--popover);color:var(--popover-foreground);box-shadow:0 14px 38px color-mix(in oklab,var(--background) 80%,transparent)}.popover[hidden]{display:none}.popover h2{margin:3px 4px 10px;font-size:14px}.popover input{width:100%;height:36px;border:1px solid var(--border);border-radius:7px;background:var(--background);padding:0 10px}.popover-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:10px}.text-button{height:32px;padding:0 10px;border-radius:6px}.text-button:hover,.menu-item:hover{background:var(--accent)}.primary{background:var(--primary);color:var(--primary-foreground)}.danger{margin-right:auto;color:var(--destructive)}#browser-menu{width:270px;padding:6px}.menu-item{display:flex;width:100%;height:34px;align-items:center;padding:0 10px;border-radius:5px;text-align:left}.menu-separator{height:1px;margin:5px;background:var(--border)}.extension-row{display:flex;align-items:center;gap:10px;padding:8px 5px}.extension-row img{object-fit:contain}.extension-row div{display:flex;min-width:0;flex-direction:column}.extension-row strong,.extension-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.extension-row small,#extensions-empty{color:var(--muted-foreground);font-size:11px}#extensions-list{max-height:260px;overflow:auto}#error{position:fixed;z-index:30;right:16px;top:calc(var(--chrome-height) + 12px);max-width:min(460px,calc(100vw - 32px));padding:10px 13px;border:1px solid var(--destructive);border-radius:8px;background:var(--popover);color:var(--destructive);box-shadow:0 8px 28px color-mix(in oklab,var(--background) 80%,transparent)}#error[hidden]{display:none}@media(max-width:720px){#profile{display:none}.tab{flex-basis:150px}.toolbar-button{width:31px}.address-wrap{min-width:80px}}
</style></head><body><div id="chrome"><div id="tab-strip"><span id="profile">Umbra</span><div id="tabs" role="tablist" aria-label="Вкладки"></div><button id="new" class="toolbar-button" title="Новая вкладка (Ctrl+T)" aria-label="Новая вкладка">+</button></div>
<form id="navigate"><button id="back" type="button" class="toolbar-button" title="Назад (Alt+Left)" aria-label="Назад">${back}</button><button id="forward" type="button" class="toolbar-button" title="Вперёд (Alt+Right)" aria-label="Вперёд">${forward}</button><button id="reload" type="button" class="toolbar-button" title="Обновить страницу" aria-label="Обновить страницу">${reload}</button><button id="home" type="button" class="toolbar-button" title="Домой" aria-label="Домой">${home}</button><div class="address-wrap"><input id="address" type="text" aria-label="Адрес и поиск" placeholder="Поиск или адрес сайта" autocomplete="off" spellcheck="false"><button id="star" type="button" class="toolbar-button" title="Добавить в закладки (Ctrl+D)" aria-label="Закладка">${star}</button></div><button id="extensions" type="button" class="toolbar-button" title="Расширения" aria-label="Расширения">${puzzle}<span id="extensions-count"></span></button><button id="menu-button" type="button" class="toolbar-button" title="Настройка и управление" aria-label="Настройка и управление">${menuIcon}</button></form><div id="bookmarks-bar" aria-label="Панель закладок"></div></div>
<div id="bookmark-popover" class="popover" hidden><h2>Закладка</h2><input id="bookmark-title" aria-label="Название закладки" maxlength="120"><div class="popover-actions"><button id="bookmark-remove" type="button" class="text-button danger">Удалить</button><button id="bookmark-save" type="button" class="text-button primary">Готово</button></div></div>
<div id="extensions-popover" class="popover" hidden><h2>Расширения</h2><div id="extensions-list"></div><p id="extensions-empty">В этом профиле нет расширений.</p><div class="popover-actions"><button id="manage-extensions" type="button" class="text-button">Управление расширениями</button></div></div>
<div id="browser-menu" class="popover" hidden><button class="menu-item" data-action="new">Новая вкладка</button><button class="menu-item" data-action="duplicate">Дублировать вкладку</button><button id="restore-menu" class="menu-item" data-action="reopen-closed">Открыть закрытую вкладку</button><div class="menu-separator"></div><button class="menu-item" data-action="toggle-bookmark-bar">Показать или скрыть панель закладок</button><button class="menu-item" data-action="manage-extensions">Управление расширениями</button><div class="menu-separator"></div><button class="menu-item" data-action="close-profile">Закрыть профиль</button></div>
<div id="error" role="alert" hidden></div>${homeMarkup}<script>${script}</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = { browserUrl };
