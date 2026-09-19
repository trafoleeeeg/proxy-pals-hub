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
  const manager = byId("bookmark-manager");
  const proxyPage = byId("proxy-page");
  const findbar = byId("findbar");
  const findInput = byId("find-input");
  const managerSearch = byId("manager-search");
  const newTab = byId("new");
  const pinnedExtensions = byId("pinned-extensions");
  const tabNodes = new Map();
  let current;
  let latestState = {};
  let draggedTab;
  let draggedBookmark;
  let sentChromeHeight;
  let managerSignature;
  let barSignature;
  let extensionSignature;
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
    const closesManager = manager !== except && !manager.hidden;
    const closesProxies = proxyPage !== except && !proxyPage.hidden;
    for (const popover of [bookmarkPopover, extensionsPopover, menu, manager, proxyPage]) if (popover !== except) popover.hidden = true;
    if (closesManager) void run({ action: "hide-bookmarks" });
    if (closesProxies) void run({ action: "hide-proxies" });
    if (!except || except === manager || except === proxyPage) void run({ action: "chrome-overlay-height", value: 0 });
  };
  const syncPopoverLayer = (popover) => {
    if (!popover || popover.hidden || popover === manager || popover === proxyPage) { void run({ action: "chrome-overlay-height", value: 0 }); return; }
    requestAnimationFrame(() => void run({ action: "chrome-overlay-height", value: Math.ceil(popover.getBoundingClientRect().bottom + 8) }));
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
      syncPopoverLayer(popover);
    } else syncPopoverLayer();
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
  for (const action of ["back", "forward", "reload", "new"]) {
    byId(action).addEventListener("click", () => void run({ action }));
  }
  byId("home-button").addEventListener("click", () => void run({ action: "home" }));
  byId("star").addEventListener("click", () => {
    const saved = (latestState.bookmarks || []).find((item) => item.url === current?.url);
    byId("bookmark-title").value = saved?.title || current?.title || "";
    byId("bookmark-remove").hidden = !saved;
    togglePopover(bookmarkPopover, byId("star"));
  });
  byId("bookmark-save").addEventListener("click", () => { bookmarkPopover.hidden = true; syncPopoverLayer(); void run({ action: "save-bookmark", title: byId("bookmark-title").value }); });
  byId("bookmark-remove").addEventListener("click", () => {
    const saved = (latestState.bookmarks || []).find((item) => item.url === current?.url);
    bookmarkPopover.hidden = true;
    syncPopoverLayer();
    if (saved) void run({ action: "remove-bookmark", id: saved.id });
  });
  byId("extensions").addEventListener("click", () => togglePopover(extensionsPopover, byId("extensions")));
  byId("menu-button").addEventListener("click", () => togglePopover(menu, byId("menu-button")));
  function openManager() {
    closePopovers(manager);
    manager.hidden = false;
    renderManager();
    managerSearch.focus();
    void run({ action: "show-bookmarks" });
  }
  byId("bookmarks-button").addEventListener("click", openManager);
  function openProxies() {
    closePopovers(proxyPage);
    proxyPage.hidden = false;
    renderProxies();
    void run({ action: "show-proxies" });
  }
  byId("proxy-button").addEventListener("click", openProxies);
  byId("proxy-close").addEventListener("click", () => { proxyPage.hidden = true; void run({ action: "hide-proxies" }); });
  byId("proxy-check").addEventListener("click", () => void run({ action: "check-connection" }));
  byId("leak-check").addEventListener("click", () => void run({ action: "check-leaks" }));
  byId("proxy-failover").addEventListener("change", (event) => void run({ action: "toggle-proxy-failover", value: event.target.checked }));
  function renderLeaks() {
    const list = byId("leak-list");
    const leaks = latestState.leaks;
    byId("leak-check").disabled = latestState.leakChecking === true;
    if (latestState.leakChecking) {
      list.replaceChildren(Object.assign(document.createElement("li"), { textContent: "Проверяем DNS, WebRTC и внешний IP…" }));
      return;
    }
    if (!leaks) {
      list.replaceChildren(Object.assign(document.createElement("li"), { textContent: "Проверка ещё не выполнялась" }));
      return;
    }
    const labels = { ok: "в порядке", leak: "утечка", error: "не удалось проверить", skip: "не требуется" };
    list.replaceChildren(...(leaks.checks || []).map((check) => {
      const item = document.createElement("li");
      item.className = `leak-${check.state}`;
      const dot = document.createElement("span"); dot.className = "leak-dot";
      const title = document.createElement("strong"); title.textContent = check.label;
      const state = document.createElement("span"); state.textContent = labels[check.state] || check.state;
      const detail = document.createElement("span"); detail.className = "leak-detail"; detail.textContent = check.detail || "";
      item.append(dot, title, state, detail);
      return item;
    }));
    if (leaks.leaked) {
      const warn = document.createElement("li");
      warn.className = "leak-leak";
      warn.textContent = "Трафик профиля заблокирован до устранения утечки. Смените прокси-сервер.";
      list.append(warn);
    }
  }

  function renderProxies() {
    renderLeaks();
    const list = byId("proxy-list");
    const proxies = latestState.proxies || [];
    byId("proxy-failover").checked = latestState.proxyFailover === true;
    list.replaceChildren(...proxies.map((proxy) => {
      const row = document.createElement("div"); row.className = "manager-row proxy-row";
      const text = document.createElement("div"); text.className = "proxy-text";
      const title = document.createElement("strong");
      title.textContent = proxy.label || `${String(proxy.protocol).toUpperCase()} · ${proxy.host}:${proxy.port}`;
      const meta = document.createElement("small");
      const place = [proxy.country, proxy.city].filter(Boolean).join(", ");
      const speed = proxy.active
        ? (proxy.checking ? "проверяем…" : proxy.ok === true ? `подключён · ${proxy.ip || "IP неизвестен"} · ${proxy.latency ?? "—"} мс` : "нет соединения")
        : "не используется";
      meta.textContent = [`${String(proxy.protocol).toUpperCase()} · ${proxy.host}:${proxy.port}`, place, speed].filter(Boolean).join(" · ");
      text.append(title, meta);
      const actions = document.createElement("div"); actions.className = "row-actions";
      const button = document.createElement("button"); button.type = "button";
      button.className = proxy.active ? "text-button" : "text-button primary";
      button.textContent = proxy.active ? "Активен" : "Использовать";
      button.disabled = !!proxy.active;
      button.onclick = () => void run({ action: "switch-proxy", id: proxy.id });
      actions.append(button);
      row.append(text, actions);
      return row;
    }));
    byId("proxy-empty").hidden = proxies.length > 0;
  }
  byId("manager-close").addEventListener("click", () => { manager.hidden = true; void run({ action: "hide-bookmarks" }); });
  function openFind() {
    closePopovers();
    findbar.hidden = false;
    findInput.focus(); findInput.select();
    syncPopoverLayer(findbar);
  }
  function closeFind() {
    findbar.hidden = true;
    byId("find-count").textContent = "";
    findInput.value = "";
    syncPopoverLayer();
    void run({ action: "find-stop" });
  }
  function renderManager() {
    const list = byId("manager-list");
    const query = managerSearch.value.trim().toLocaleLowerCase("ru");
    const visible = (latestState.bookmarks || []).filter((bookmark) => !query || `${bookmark.title} ${bookmark.url}`.toLocaleLowerCase("ru").includes(query));
    list.replaceChildren(...visible.map((bookmark) => {
      const row = document.createElement("div"); row.className = "manager-row"; row.draggable = !query && !bookmark.managed; row.dataset.id = bookmark.id;
      const favicon = document.createElement(bookmark.favicon ? "img" : "span"); favicon.className = "manager-favicon";
      if (bookmark.favicon) { favicon.src = bookmark.favicon; favicon.alt = ""; } else favicon.innerHTML = icon("globe");
      const fields = document.createElement("div"); fields.className = "manager-fields";
      const title = document.createElement("input"); title.value = bookmark.title || ""; title.maxLength = 120;
      title.setAttribute("aria-label", "Название закладки");
      const url = document.createElement("input"); url.value = bookmark.url || ""; url.maxLength = 2048;
      url.setAttribute("aria-label", "Адрес закладки");
      title.readOnly = bookmark.managed === true; url.readOnly = bookmark.managed === true;
      const actions = document.createElement("div"); actions.className = "row-actions";
      const open = document.createElement("button"); open.type = "button"; open.className = "text-button"; open.textContent = "Открыть";
      open.onclick = () => { manager.hidden = true; void run({ action: "open-bookmark", id: bookmark.id }); };
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "text-button danger"; remove.textContent = "Удалить";
      remove.onclick = () => void run({ action: "remove-bookmark", id: bookmark.id });
      const save = document.createElement("button"); save.type = "button"; save.className = "text-button primary"; save.textContent = "Сохранить";
      save.onclick = () => void run({ action: "update-bookmark", id: bookmark.id, title: title.value, url: url.value });
      if (bookmark.managed) {
        const managed = document.createElement("span"); managed.className = "managed-bookmark"; managed.textContent = "Для всей команды";
        actions.append(open, managed);
      } else actions.append(open, remove, save);
      fields.append(title, url); row.append(favicon, fields, actions);
      row.addEventListener("dragstart", () => { draggedBookmark = bookmark.id; row.classList.add("dragging"); });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (event) => { if (!query) event.preventDefault(); });
      row.addEventListener("drop", (event) => {
        event.preventDefault(); if (query || bookmark.managed || !draggedBookmark || draggedBookmark === bookmark.id) return;
        const ids = latestState.bookmarks.map((item) => item.id); const from = ids.indexOf(draggedBookmark); const to = ids.indexOf(bookmark.id);
        ids.splice(to, 0, ids.splice(from, 1)[0]); void run({ action: "reorder-bookmarks", ids });
      });
      return row;
    }));
    byId("manager-empty").hidden = visible.length > 0;
  }
  menu.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const local = button.dataset.local;
    if (local) {
      menu.hidden = true;
      syncPopoverLayer();
      if (local === "find") openFind();
      else if (local === "proxies") openProxies();
      else openManager();
      return;
    }
    const action = button.dataset.action;
    if (!action) return;
    menu.hidden = true;
    syncPopoverLayer();
    void run({ action });
  });
  byId("manager-add").addEventListener("click", () => {
    void run({ action: "add-bookmark", title: byId("manager-new-title").value, url: byId("manager-new-url").value })
      .then(() => { byId("manager-new-title").value = ""; byId("manager-new-url").value = ""; });
  });
  managerSearch.addEventListener("input", renderManager);
  findInput.addEventListener("input", () => void run({ action: "find", value: findInput.value }));
  findInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void run({ action: "find", value: findInput.value, next: true, forward: !event.shiftKey }); }
    if (event.key === "Escape") closeFind();
  });
  byId("find-next").addEventListener("click", () => void run({ action: "find", value: findInput.value, next: true, forward: true }));
  byId("find-prev").addEventListener("click", () => void run({ action: "find", value: findInput.value, next: true, forward: false }));
  byId("find-close").addEventListener("click", closeFind);
  byId("manage-extensions").addEventListener("click", () => { extensionsPopover.hidden = true; syncPopoverLayer(); void run({ action: "manage-extensions" }); });
  address.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && current) { address.value = current.url === "about:blank" ? "" : current.url; address.blur(); }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".popover,.toolbar-button,#bookmark-manager,#proxy-page")) closePopovers();
    // Клик по любой части оболочки закрывает окно расширения, как в Chrome.
    if (!event.target.closest(".pinned-extension,#extensions")) void run({ action: "close-extension" });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closePopovers(); void run({ action: "close-extension" }); }
  });
  api.subscribe((incoming) => {
    if (incoming.focusAddress) { address.focus(); address.select(); return; }
    if (incoming.focusFind) { openFind(); return; }
    // Тяжёлые списки приходят только при изменении, поэтому дополняем прошлое состояние.
    const state = { ...latestState, ...incoming };
    latestState = state;
    manager.hidden = !state.bookmarksOpen;
    proxyPage.hidden = !state.proxiesOpen;
    if (state.proxiesOpen) renderProxies();
    const signature = (state.bookmarks || []).map((item) => item.id + ":" + item.url + ":" + (item.favicon ? "i" : "")).join("|");
    if (state.bookmarksOpen && signature !== managerSignature) renderManager();
    managerSignature = signature;
    byId("find-count").textContent = state.find && findInput.value ? `${state.find.active}/${state.find.total}` : "";
    current = state.tabs.find((tab) => tab.id === state.activeId);
    byId("home").hidden = !state.home;
    renderHome(state.info);
    document.title = state.proxiesOpen ? "Прокси — Umbra" : state.bookmarksOpen ? "Закладки — Umbra" : state.name + " — Umbra";
    if (document.activeElement !== address) address.value = state.proxiesOpen ? "umbra://proxies" : state.bookmarksOpen ? "umbra://bookmarks" : current?.url === "about:blank" ? "" : current?.url || "";
    showError(state.error || current?.error || "");
    byId("back").disabled = !current?.canGoBack;
    byId("forward").disabled = !current?.canGoForward;
    const reload = byId("reload");
    reload.classList.toggle("loading", !!current?.loading);
    reload.title = current?.loading ? "Остановить загрузку" : "Обновить страницу";
    reload.setAttribute("aria-label", reload.title);
    byId("star").classList.toggle("on", !!state.bookmarked);
    byId("restore-menu").disabled = !state.canRestoreTab;
    byId("zoom-value").textContent = `${state.zoomPercent || 100}%`;
    const focused = document.activeElement?.dataset?.focusKey;
    // Вкладки обновляем точечно: полная перерисовка на каждое событие загрузки
    // убирала кнопку из-под курсора, и клик по вкладке терялся.
    const seen = new Set();
    let previous = null;
    for (const tab of state.tabs) {
      seen.add(tab.id);
      let node = tabNodes.get(tab.id);
      if (!node) {
        const item = document.createElement("div");
        item.className = "tab"; item.dataset.id = tab.id; item.draggable = true;
        const select = document.createElement("button");
        select.className = "tab-title"; select.setAttribute("role", "tab");
        select.dataset.focusKey = "tab-" + tab.id;
        const favicon = document.createElement("span"); favicon.className = "favicon"; favicon.innerHTML = icon("globe");
        const label = document.createElement("span"); label.className = "tab-label";
        select.append(favicon, label);
        select.onclick = () => void run({ action: "select", id: item.dataset.id });
        select.onauxclick = (event) => { if (event.button === 1) void run({ action: "close-tab", id: item.dataset.id }); };
        const close = document.createElement("button"); close.innerHTML = icon("close");
        close.className = "tab-close"; close.title = "Закрыть вкладку"; close.setAttribute("aria-label", "Закрыть вкладку");
        close.dataset.focusKey = "close-" + tab.id;
        close.onclick = () => void run({ action: "close-tab", id: item.dataset.id });
        item.addEventListener("dragstart", () => { draggedTab = item.dataset.id; item.classList.add("dragging"); });
        item.addEventListener("dragend", () => { draggedTab = undefined; item.classList.remove("dragging"); });
        item.addEventListener("dragover", (event) => event.preventDefault());
        item.addEventListener("drop", (event) => {
          event.preventDefault();
          const id = item.dataset.id;
          if (!draggedTab || draggedTab === id) return;
          const ids = (latestState.tabs || []).map((entry) => entry.id);
          const from = ids.indexOf(draggedTab); const to = ids.indexOf(id);
          if (from < 0 || to < 0) return;
          ids.splice(to, 0, ids.splice(from, 1)[0]);
          void run({ action: "reorder-tabs", ids });
        });
        item.append(select, close);
        node = { item, select, label, favicon, shown: {} };
        tabNodes.set(tab.id, node);
      }
      const blank = !tab.url || tab.url === "about:blank";
      const name = blank || !tab.title || tab.title === "about:blank" ? "Новая вкладка" : tab.title;
      const title = blank ? name : `${name}\n${tab.url}`;
      const selected = String(tab.id === state.activeId);
      if (node.shown.name !== name) { node.label.textContent = name; node.shown.name = name; }
      if (node.shown.title !== title) { node.select.title = title; node.shown.title = title; }
      if (node.shown.selected !== selected) { node.select.setAttribute("aria-selected", selected); node.shown.selected = selected; }
      const source = tab.favicon || "";
      if (node.shown.favicon !== source) {
        node.shown.favicon = source;
        const next = document.createElement(source ? "img" : "span");
        next.className = "favicon";
        if (source) { next.src = source; next.alt = ""; } else next.innerHTML = icon("globe");
        node.favicon.replaceWith(next); node.favicon = next;
      }
      const expected = previous ? previous.nextSibling : tabs.firstChild;
      if (expected !== node.item) tabs.insertBefore(node.item, expected);
      previous = node.item;
    }
    for (const [id, node] of [...tabNodes]) if (!seen.has(id)) { node.item.remove(); tabNodes.delete(id); }
    if (focused) [...document.querySelectorAll("[data-focus-key]")].find((button) => button.dataset.focusKey === focused)?.focus();
    newTab.disabled = state.tabs.length >= 32;
    bookmarksBar.hidden = !state.bookmarkBarVisible || !(state.bookmarks || []).length;
    if (signature !== barSignature) {
    barSignature = signature;
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
    }
    const extensions = state.extensions || [];
    const extensionKey = extensions.map((item) => item.id + ":" + item.pinned + ":" + item.enabled + ":" + item.failed + ":" + (item.popup || "") + ":" + (item.options || "")).join("|");
    if (extensionKey !== extensionSignature) {
    extensionSignature = extensionKey;
    byId("extensions-count").textContent = extensions.length ? String(extensions.length) : "";
    const list = byId("extensions-list");
    const openExtension = (extension, anchor) => {
      extensionsPopover.hidden = true;
      syncPopoverLayer();
      const rect = anchor?.getBoundingClientRect?.();
      void run({ action: "open-extension", id: extension.id, anchor: rect ? Math.round(rect.right) : 0 });
    };
    const openable = (extension) => !extension.failed && (extension.popup || extension.options);
    const hint = (extension) => extension.failed
      ? `${extension.name}: не удалось загрузить`
      : extension.popup ? `Открыть ${extension.name}`
      : extension.options ? `${extension.name}: настройки`
      : `${extension.name}: своего окна нет`;
    list.replaceChildren(...extensions.map((extension) => {
      const row = document.createElement("div"); row.className = "extension-row";
      const open = document.createElement("button"); open.type = "button"; open.className = "extension-open";
      open.title = hint(extension);
      open.setAttribute("aria-label", open.title);
      open.disabled = !openable(extension);
      const image = document.createElement(extension.icon ? "img" : "span"); image.className = "extension-icon";
      if (extension.icon) { image.src = extension.icon; image.alt = ""; } else image.innerHTML = icon("globe");
      const text = document.createElement("div"); const title = document.createElement("strong"); title.textContent = extension.name;
      const meta = document.createElement("small");
      meta.textContent = `Версия ${extension.version} · ${extension.failed ? "не загрузилось" : extension.popup ? "готово" : extension.options ? "только настройки" : "без окна"}`;
      text.append(title, meta); open.append(image, text);
      open.onclick = () => openExtension(extension, open);
      const pin = document.createElement("button"); pin.type = "button"; pin.className = "pin-extension";
      pin.title = extension.pinned ? "Открепить от панели" : "Закрепить на панели";
      pin.setAttribute("aria-label", pin.title); pin.textContent = extension.pinned ? "●" : "○";
      pin.onclick = () => void run({ action: "pin-extension", id: extension.id, pinned: !extension.pinned });
      row.append(open, pin); return row;
    }));
    byId("extensions-empty").hidden = extensions.length > 0;
    // Панель вмещает ограниченное число значков, остальные остаются в списке расширений.
    const pinned = extensions.filter((extension) => extension.pinned).slice(0, 6);
    pinnedExtensions.replaceChildren(...pinned.map((extension) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "toolbar-button pinned-extension";
      button.title = hint(extension); button.setAttribute("aria-label", `Расширение: ${extension.name}`);
      if (extension.icon) { const image = document.createElement("img"); image.src = extension.icon; image.alt = ""; button.append(image); }
      else button.innerHTML = icon("globe");
      // Клик по значку открывает само расширение, как в Chrome.
      button.onclick = () => openable(extension) ? openExtension(extension, button) : togglePopover(extensionsPopover, button);
      return button;
    }));
    }
    manager.style.top = byId("chrome").offsetHeight + "px";
    proxyPage.style.top = byId("chrome").offsetHeight + "px";
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
  const bookmarksIcon = svg('<path d="M5 4h14v16l-7-4-7 4V4z"/>');
  const proxyIcon = svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>');
  const search = svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>');
  const menuIcon = svg('<circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/>');
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'">
<title>Umbra</title><style>${tokens}${homeStyle}
 *{box-sizing:border-box;letter-spacing:0}html{--chrome-height:90px}body{margin:0;background:var(--background);color:var(--foreground);font:13px "Segoe UI Variable","Segoe UI",system-ui,sans-serif;overflow:hidden}button,input{font:inherit;color:inherit}button{border:0;background:transparent;cursor:pointer}button:disabled{opacity:.35;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid var(--ring);outline-offset:1px}svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}#chrome{position:relative;z-index:5;background:var(--sidebar);box-shadow:0 1px 0 var(--border)}
 #tab-strip{display:flex;align-items:end;height:42px;padding:8px 7px 0;gap:1px;background:var(--sidebar)}#tabs{display:flex;flex:0 1 auto;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;gap:1px}#tabs::-webkit-scrollbar{display:none}#tab-spacer{flex:1 1 auto;min-width:0}.tab{display:flex;position:relative;flex:0 1 240px;min-width:62px;max-width:250px;height:34px;border-radius:9px 9px 0 0;color:var(--muted-foreground)}.tab:hover{background:color-mix(in oklab,var(--secondary) 72%,transparent)}.tab:has([aria-selected=true]){background:var(--secondary);color:var(--foreground)}.tab.dragging,.manager-row.dragging{opacity:.5}.tab-title{display:flex;align-items:center;gap:8px;min-width:0;flex:1;padding:0 4px 0 11px;text-align:left}.tab-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.favicon,.extension-icon{display:grid;place-items:center;width:16px;height:16px;flex:none;object-fit:contain}.favicon svg,.extension-icon svg{width:15px;height:15px}.tab-close{display:grid;place-items:center;width:28px;height:28px;margin:2px 3px 0 0;border-radius:50%;flex:none}.tab-close:hover,.toolbar-button:hover{background:var(--accent)}.tab-close svg{width:14px;height:14px}#new{margin:0 4px 3px;width:30px;height:30px;font-size:24px;border-radius:50%}
 #navigate{display:flex;align-items:center;gap:5px;height:48px;margin:0;padding:6px 9px;background:var(--secondary);border-bottom:1px solid var(--border)}.toolbar-button{position:relative;display:grid;place-items:center;width:34px;height:34px;border-radius:50%;flex:none}.address-wrap{display:flex;align-items:center;min-width:120px;flex:1;height:34px;padding:0 4px 0 13px;border:1px solid transparent;border-radius:18px;background:var(--background)}.address-wrap:focus-within{border-color:var(--ring);box-shadow:0 0 0 1px var(--ring)}#address{min-width:0;flex:1;height:31px;border:0;outline:0;background:transparent}.reload-path{display:block}.stop-path{display:none}.loading .reload-path{display:none}.loading .stop-path{display:block}#star.on svg{fill:var(--primary);stroke:var(--primary)}#extensions-count{position:absolute;right:1px;bottom:1px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--primary);color:var(--primary-foreground);font-size:9px;line-height:14px}#extensions-count:empty{display:none}#pinned-extensions{display:flex;align-items:center;gap:1px}.pinned-extension img{width:18px;height:18px;object-fit:contain}
 #bookmarks-bar{display:flex;align-items:center;gap:3px;height:32px;padding:3px 10px;background:var(--secondary);overflow-x:auto;scrollbar-width:thin}#bookmarks-bar[hidden]{display:none}.bookmark{display:flex;align-items:center;gap:7px;flex:none;max-width:190px;height:26px;padding:0 8px;border-radius:5px}.bookmark:hover{background:var(--accent)}.bookmark-favicon{display:grid;place-items:center;width:16px;height:16px;flex:none;object-fit:contain}.bookmark-favicon svg{width:15px;height:15px}.bookmark span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.popover{position:fixed;top:88px;z-index:20;width:310px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--popover);color:var(--popover-foreground);box-shadow:0 12px 30px color-mix(in oklab,var(--background) 72%,transparent)}.popover[hidden]{display:none}.popover h2{margin:3px 4px 10px;font-size:14px}.popover input{width:100%;height:36px;border:1px solid var(--border);border-radius:6px;background:var(--background);padding:0 10px}.popover-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:10px}.text-button{height:32px;padding:0 10px;border-radius:6px}.text-button:hover,.menu-item:hover{background:var(--accent)}.primary{background:var(--primary);color:var(--primary-foreground)}.danger{color:var(--destructive)}#browser-menu{width:292px;padding:6px}.menu-item{display:flex;width:100%;height:34px;align-items:center;padding:0 10px;border-radius:5px;text-align:left}.menu-separator{height:1px;margin:5px;background:var(--border)}.zoom-row{display:flex;align-items:center;gap:6px;padding:4px 8px}.zoom-row>span:first-child{margin-right:auto}.zoom-button{width:30px;height:30px;border-radius:50%;font-size:19px}.zoom-button:hover{background:var(--accent)}#zoom-value{width:48px;text-align:center}.extension-row{display:grid;grid-template-columns:minmax(0,1fr) 30px;align-items:center;gap:6px;padding:4px 5px}.extension-open{display:grid;grid-template-columns:18px minmax(0,1fr);align-items:center;gap:10px;min-width:0;padding:6px 5px;border-radius:6px;text-align:left}.extension-open:hover{background:var(--accent)}.extension-row img{object-fit:contain}.extension-row div{display:flex;min-width:0;flex-direction:column}.pin-extension{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;color:var(--muted-foreground);font-size:17px}.pin-extension:hover{background:var(--accent);color:var(--foreground)}.extension-row strong,.extension-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.extension-row small,#extensions-empty{color:var(--muted-foreground);font-size:11px}#extensions-list{max-height:260px;overflow:auto}#error{position:fixed;z-index:30;right:16px;top:calc(var(--chrome-height) + 12px);max-width:min(460px,calc(100vw - 32px));padding:10px 13px;border:1px solid var(--destructive);border-radius:8px;background:var(--popover);color:var(--destructive);box-shadow:0 8px 28px color-mix(in oklab,var(--background) 80%,transparent)}#error[hidden]{display:none}#findbar{position:fixed;z-index:25;right:18px;top:calc(var(--chrome-height) + 10px);display:flex;align-items:center;gap:5px;padding:7px 8px;border:1px solid var(--border);border-radius:8px;background:var(--popover);box-shadow:0 10px 30px color-mix(in oklab,var(--background) 75%,transparent)}#findbar[hidden]{display:none}#findbar>svg{width:16px;color:var(--muted-foreground)}#find-input{width:210px;height:30px;border:0;background:transparent;padding:0 4px;outline:0}#find-count{min-width:54px;color:var(--muted-foreground);font-size:11px;text-align:center}#findbar .text-button{display:grid;place-items:center;width:30px;padding:0}#bookmark-manager,#proxy-page{position:fixed;z-index:4;inset:var(--chrome-height) 0 0;width:auto;background:var(--background);color:var(--foreground)}#bookmark-manager[hidden],#proxy-page[hidden]{display:none}.proxy-row{grid-template-columns:minmax(0,1fr) auto}.proxy-text{display:flex;min-width:0;flex-direction:column;gap:3px}.proxy-text small{color:var(--muted-foreground);font-size:11px}.proxy-switch{display:flex;align-items:center;gap:8px;margin-left:auto;color:var(--muted-foreground)}.leak-panel{margin:14px 20px 0;padding:12px 14px;border:1px solid var(--border);border-radius:8px;background:var(--sidebar)}.leak-panel h2{margin:0 0 8px;font-size:13px;font-weight:600}.leak-panel ul{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}.leak-panel li{display:flex;align-items:center;gap:8px;font-size:12px}.leak-dot{width:9px;height:9px;flex:none;border-radius:50%;background:var(--muted-foreground)}.leak-ok .leak-dot{background:#28a745}.leak-leak .leak-dot{background:var(--destructive)}.leak-leak{color:var(--destructive)}.leak-error .leak-dot{background:#f0ad4e}.leak-detail{color:var(--muted-foreground)}#proxy-empty{padding:50px;text-align:center;color:var(--muted-foreground)}#proxy-empty[hidden]{display:none}.manager-shell{display:flex;height:100%}.manager-sidebar{width:230px;padding:22px 12px;border-right:1px solid var(--border);background:var(--sidebar)}.manager-sidebar h1{margin:0 12px 22px;font-size:20px;font-weight:500}.manager-nav{padding:10px 14px;border-left:3px solid var(--primary);background:var(--accent);color:var(--primary)}.manager-main{display:flex;min-width:0;flex:1;flex-direction:column}.manager-header{display:flex;align-items:center;gap:12px;padding:18px 24px;border-bottom:1px solid var(--border);background:var(--sidebar)}.manager-search-wrap{display:flex;align-items:center;gap:9px;max-width:600px;min-width:220px;flex:1;height:38px;padding:0 12px;border-radius:6px;background:var(--accent)}.manager-search-wrap svg{color:var(--muted-foreground)}#manager-search{width:100%;border:0;outline:0;background:transparent}.manager-close{margin-left:auto}#manager-list,#proxy-list{flex:1;overflow:auto;padding:12px 20px}.manager-row{display:grid;grid-template-columns:22px minmax(220px,1fr) auto;align-items:center;gap:12px;min-height:62px;padding:8px 12px;border-bottom:1px solid color-mix(in oklab,var(--border) 55%,transparent);border-radius:6px}.manager-row:hover{background:var(--accent)}.manager-favicon{display:grid;place-items:center;width:18px;height:18px;object-fit:contain}.manager-fields{display:grid;min-width:0;grid-template-columns:minmax(150px,.7fr) minmax(220px,1fr);gap:8px}.manager-row input,#manager-add-form input{height:34px;border:1px solid transparent;border-radius:5px;background:transparent;padding:0 8px}.manager-row input:hover,.manager-row input:focus{border-color:var(--border);background:var(--background);outline:0}.manager-row input[readonly]{color:var(--muted-foreground)}.manager-row .row-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px}.managed-bookmark{padding:0 8px;color:var(--muted-foreground);font-size:11px}.manager-add{display:grid;grid-template-columns:minmax(150px,.7fr) minmax(220px,1fr) auto;gap:8px;padding:12px 24px;border-top:1px solid var(--border);background:var(--sidebar)}#manager-empty{padding:50px;text-align:center;color:var(--muted-foreground)}#manager-empty[hidden]{display:none}@media(max-width:760px){.tab{flex-basis:150px}.toolbar-button{width:31px}.address-wrap{min-width:80px}#home-button{display:none}.manager-sidebar{display:none}.manager-fields,.manager-add{grid-template-columns:1fr}.manager-row{grid-template-columns:22px 1fr}.manager-row .row-actions{grid-column:2}.manager-add{padding:10px}}
</style></head><body><div id="chrome"><div id="tab-strip"><div id="tabs" role="tablist" aria-label="Вкладки"></div><button id="new" class="toolbar-button" title="Новая вкладка (Ctrl+T)" aria-label="Новая вкладка">+</button><div id="tab-spacer"></div></div>
 <form id="navigate"><button id="back" type="button" class="toolbar-button" title="Назад (Alt+Left)" aria-label="Назад">${back}</button><button id="forward" type="button" class="toolbar-button" title="Вперёд (Alt+Right)" aria-label="Вперёд">${forward}</button><button id="reload" type="button" class="toolbar-button" title="Обновить страницу" aria-label="Обновить страницу">${reload}</button><button id="home-button" type="button" class="toolbar-button" title="Домой" aria-label="Домой">${home}</button><div class="address-wrap"><input id="address" type="text" aria-label="Адрес и поиск" placeholder="Введите запрос или адрес" autocomplete="off" spellcheck="false"><button id="star" type="button" class="toolbar-button" title="Добавить в закладки (Ctrl+D)" aria-label="Закладка">${star}</button></div><div id="pinned-extensions" aria-label="Закреплённые расширения"></div><button id="bookmarks-button" type="button" class="toolbar-button" title="Закладки" aria-label="Открыть закладки">${bookmarksIcon}</button><button id="proxy-button" type="button" class="toolbar-button" title="Прокси" aria-label="Открыть прокси">${proxyIcon}</button><button id="extensions" type="button" class="toolbar-button" title="Расширения" aria-label="Расширения">${puzzle}<span id="extensions-count"></span></button><button id="menu-button" type="button" class="toolbar-button" title="Настройка и управление" aria-label="Настройка и управление">${menuIcon}</button></form><div id="bookmarks-bar" aria-label="Панель закладок"></div></div>
<div id="bookmark-popover" class="popover" hidden><h2>Закладка</h2><input id="bookmark-title" aria-label="Название закладки" maxlength="120"><div class="popover-actions"><button id="bookmark-remove" type="button" class="text-button danger">Удалить</button><button id="bookmark-save" type="button" class="text-button primary">Готово</button></div></div>
<div id="extensions-popover" class="popover" hidden><h2>Расширения</h2><div id="extensions-list"></div><p id="extensions-empty">В этом профиле нет расширений.</p><div class="popover-actions"><button id="manage-extensions" type="button" class="text-button">Управление расширениями</button></div></div>
 <div id="browser-menu" class="popover" hidden><button class="menu-item" data-action="new">Новая вкладка</button><button class="menu-item" data-action="duplicate">Дублировать вкладку</button><button id="restore-menu" class="menu-item" data-action="reopen-closed">Открыть закрытую вкладку</button><div class="menu-separator"></div><div class="zoom-row"><span>Масштаб</span><button type="button" class="zoom-button" data-action="zoom-out" aria-label="Уменьшить масштаб">−</button><button type="button" id="zoom-value" data-action="zoom-reset" title="Сбросить масштаб">100%</button><button type="button" class="zoom-button" data-action="zoom-in" aria-label="Увеличить масштаб">+</button></div><div class="menu-separator"></div><button class="menu-item" data-local="find">Найти на странице</button><button class="menu-item" data-action="toggle-bookmark-bar">Показать или скрыть панель закладок</button><button class="menu-item" data-local="bookmark-manager">Закладки</button><button class="menu-item" data-local="proxies">Прокси</button><button class="menu-item" data-action="manage-extensions">Управление расширениями</button><div class="menu-separator"></div><button class="menu-item" data-action="close-profile">Закрыть профиль</button></div>
 <section id="bookmark-manager" hidden aria-label="Закладки"><div class="manager-shell"><aside class="manager-sidebar"><h1>Закладки</h1><div class="manager-nav">Все закладки</div></aside><main class="manager-main"><header class="manager-header"><label class="manager-search-wrap">${search}<input id="manager-search" type="search" aria-label="Поиск закладок" placeholder="Поиск закладок" autocomplete="off"></label><button id="manager-close" type="button" class="toolbar-button manager-close" title="Закрыть закладки" aria-label="Закрыть закладки">${svg('<path d="m7 7 10 10M17 7 7 17"/>')}</button></header><div id="manager-list"></div><p id="manager-empty" hidden>Закладки не найдены</p><div id="manager-add-form" class="manager-add"><input id="manager-new-title" aria-label="Название новой закладки" placeholder="Название" maxlength="120"><input id="manager-new-url" aria-label="Адрес новой закладки" placeholder="https://example.com" maxlength="2048"><button id="manager-add" type="button" class="text-button primary">Добавить закладку</button></div></main></div></section>
 <section id="proxy-page" hidden aria-label="Прокси"><div class="manager-shell"><aside class="manager-sidebar"><h1>Прокси</h1><div class="manager-nav">Серверы команды</div></aside><main class="manager-main"><header class="manager-header"><label class="proxy-switch"><input id="proxy-failover" type="checkbox"> Переключать при сбое</label><button id="proxy-check" type="button" class="text-button">Проверить</button><button id="leak-check" type="button" class="text-button">Проверить утечки</button><button id="proxy-close" type="button" class="toolbar-button manager-close" title="Закрыть прокси" aria-label="Закрыть прокси">${svg('<path d="m7 7 10 10M17 7 7 17"/>')}</button></header><section id="leak-panel" class="leak-panel" aria-label="Проверка утечек"><h2>Утечки DNS, WebRTC и IP</h2><ul id="leak-list"></ul></section><div id="proxy-list" class="manager-list"></div><p id="proxy-empty" hidden>Для команды пока нет прокси-серверов</p></main></div></section>
<div id="findbar" hidden>${search}<input id="find-input" type="text" aria-label="Поиск на странице" placeholder="Найти на странице" autocomplete="off"><span id="find-count"></span><button id="find-prev" type="button" class="text-button" title="Предыдущее совпадение" aria-label="Предыдущее совпадение">↑</button><button id="find-next" type="button" class="text-button" title="Следующее совпадение" aria-label="Следующее совпадение">↓</button><button id="find-close" type="button" class="text-button" title="Закрыть поиск" aria-label="Закрыть поиск">✕</button></div>
<div id="error" role="alert" hidden></div>${homeMarkup}<script>${script}</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = { browserUrl };
