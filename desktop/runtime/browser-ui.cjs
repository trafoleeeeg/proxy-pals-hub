const { createHash } = require("node:crypto");
const { renderHome, homeMarkup, homeStyle } = require("./profile-home.cjs");
const { tokens } = require("./theme.cjs");

function renderer() {
  const api = window.profileBrowser;
  const address = document.getElementById("address");
  const tabs = document.getElementById("tabs");
  const error = document.getElementById("error");
  const bar = document.getElementById("bar");
  const newTab = document.getElementById("new");
  const star = document.getElementById("star");
  const extensionsButton = document.getElementById("extensions");
  const homeButton = document.createElement("button");
  homeButton.id = "go-home"; homeButton.type = "button"; homeButton.className = "icon";
  homeButton.textContent = "⌂"; homeButton.title = "Показатели профиля"; homeButton.setAttribute("aria-label", "Показатели профиля");
  address.before(homeButton);
  let current;
  let showExtensions = false;
  const run = (command) => api.command(command).then((result) => {
    if (result?.error) error.textContent = result.error;
  }).catch(() => { error.textContent = "Browser command failed"; });
  document.getElementById("navigate").addEventListener("submit", (event) => {
    event.preventDefault(); address.blur(); run({ action: "navigate", value: address.value });
  });
  document.getElementById("home-search").addEventListener("submit", (event) => {
    event.preventDefault(); run({ action: "navigate", value: document.getElementById("home-address").value });
  });
  for (const action of ["back", "forward", "reload", "new", "home", "duplicate", "bookmark", "check-connection", "close-profile"]) {
    const id = action === "home" ? "go-home" : action === "bookmark" ? "star" : action;
    document.getElementById(id).addEventListener("click", () => run({ action }));
  }
  extensionsButton.addEventListener("click", () => { showExtensions = !showExtensions; run({ action: "state" }); });
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
    star.textContent = state.bookmarked ? "\u2605" : "\u2606";
    star.classList.toggle("on", !!state.bookmarked);
    star.title = state.bookmarked ? "Убрать из закладок (Ctrl+D)" : "В закладки (Ctrl+D)";
    star.setAttribute("aria-label", star.title);
    const extensions = state.extensions || [];
    extensionsButton.title = "Расширения: " + extensions.length;
    extensionsButton.setAttribute("aria-label", extensionsButton.title);
    extensionsButton.classList.toggle("on", showExtensions);
    const focusedTab = document.activeElement?.dataset?.focusKey;
    tabs.replaceChildren(...state.tabs.map((tab) => {
      const item = document.createElement("div"); item.className = "tab";
      const select = document.createElement("button");
      select.className = "tab-title"; select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(tab.id === state.activeId));
      select.dataset.focusKey = "tab-" + tab.id;
      select.textContent = tab.title || "Новая вкладка"; select.title = tab.title || tab.url;
      select.onclick = () => run({ action: "select", id: tab.id });
      select.onauxclick = (event) => { if (event.button === 1) run({ action: "close-tab", id: tab.id }); };
      const close = document.createElement("button"); close.textContent = "\u00d7";
      close.className = "tab-close"; close.title = "Закрыть вкладку"; close.setAttribute("aria-label", "Закрыть вкладку");
      close.dataset.focusKey = "close-" + tab.id;
      close.onclick = () => run({ action: "close-tab", id: tab.id });
      item.append(select, close); return item;
    }), newTab);
    if (focusedTab) [...tabs.querySelectorAll("button")].find((button) => button.dataset.focusKey === focusedTab)?.focus();
    newTab.disabled = state.tabs.length >= 32;
    const bookmarks = state.bookmarks || [];
    if (showExtensions) {
      bar.replaceChildren(...(extensions.length ? extensions.map((extension) => {
        const chip = document.createElement("span"); chip.className = "chip static";
        chip.textContent = "\ud83e\udde9 " + extension.name + " " + extension.version;
        chip.title = extension.name + " " + extension.version;
        return chip;
      }) : [Object.assign(document.createElement("span"), { className: "hint", textContent: "Расширения не подключены. Добавьте их в разделе «Приложение»." })]));
    } else {
      bar.replaceChildren(...(bookmarks.length ? bookmarks.map((bookmark) => {
        const chip = document.createElement("span"); chip.className = "chip";
        const open = document.createElement("button"); open.className = "chip-open";
        open.textContent = bookmark.title || bookmark.url; open.title = bookmark.url;
        open.onclick = () => run({ action: "open-bookmark", id: bookmark.id });
        open.onauxclick = (event) => { if (event.button === 1) run({ action: "open-bookmark", id: bookmark.id, newTab: true }); };
        const drop = document.createElement("button"); drop.className = "chip-close"; drop.textContent = "\u00d7";
        drop.title = "Удалить закладку"; drop.setAttribute("aria-label", "Удалить закладку");
        drop.onclick = () => run({ action: "remove-bookmark", id: bookmark.id });
        chip.append(open, drop); return chip;
      }) : [Object.assign(document.createElement("span"), { className: "hint", textContent: "Закладок пока нет. Нажмите звёздочку в адресной строке." })]));
    }
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
.icon{width:32px;font-size:20px}#navigate{display:flex;align-items:center;gap:6px;height:44px;margin:0;padding:6px 10px}#address{min-width:0;width:100%;height:30px;background:#242630;border:1px solid #4d5160;border-radius:4px;padding:0 10px}#error{height:24px;color:#ffb4b4;padding:3px 12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}#new{font-size:22px;width:30px;align-self:center}#close-profile{font-size:19px}#star{font-size:18px}#star.on,#extensions.on{color:#7cdeca;background:#2c2f3a}
#bar{display:flex;align-items:center;gap:6px;height:36px;padding:0 10px;background:#15171e;border-top:1px solid #23252e;border-bottom:1px solid #383a44;overflow-x:auto;scrollbar-width:thin}.chip{display:flex;align-items:center;flex:0 0 auto;max-width:230px;height:24px;background:#242630;border-radius:4px}.chip.static{padding:0 9px;color:#c9ccd6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.chip-open{height:24px;max-width:190px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:0 9px}.chip-close{height:24px;width:22px;font-size:16px}.hint{color:#868b99;white-space:nowrap}
</style></head><body><div id="top"><span id="profile">Umbra</span><div id="tabs" role="tablist" aria-label="Tabs"><button id="new" class="icon" title="Новая вкладка (Ctrl+T)" aria-label="Новая вкладка">+</button></div><button id="close-profile" class="icon" title="Закрыть профиль" aria-label="Закрыть профиль">&#9211;</button></div>
<form id="navigate"><button id="back" type="button" class="icon" title="Назад" aria-label="Назад">&#8592;</button><button id="forward" type="button" class="icon" title="Вперёд" aria-label="Вперёд">&#8594;</button><button id="reload" type="button" class="icon" title="Обновить" aria-label="Обновить">&#8635;</button><input id="address" type="text" aria-label="Адрес" placeholder="Поиск или адрес сайта" autocomplete="off" spellcheck="false"><button id="star" type="button" class="icon" title="В закладки (Ctrl+D)" aria-label="В закладки">&#9734;</button><button id="duplicate" type="button" class="icon" title="Дублировать вкладку" aria-label="Дублировать вкладку">&#10697;</button><button id="extensions" type="button" class="icon" title="Расширения" aria-label="Расширения">&#129513;</button><button class="icon" type="submit" title="Перейти" aria-label="Перейти">&#8594;</button></form>
<div id="bar" aria-label="Закладки и расширения"></div>
<div id="error" role="status" aria-live="polite"></div>${homeMarkup}<script>${script}</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = { browserUrl };
