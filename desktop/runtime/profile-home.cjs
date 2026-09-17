function renderHome(info = {}) {
  const home = document.getElementById("home");
  if (!home) return;
  document.getElementById("home-name").textContent = info.name || "Профиль";
  document.getElementById("home-id").textContent = info.profileId || "";
  const metrics = [
    ["Внешний IP", info.ip || "Ещё не проверен"],
    ["Подключение", info.proxy || "Без прокси"],
    ["Страна · город", [info.country, info.city].filter(Boolean).join(" · ") || "Нет данных"],
    ["Задержка", info.latency == null ? "Нет данных" : info.latency + " мс"],
    ["Часовой пояс", info.timezone || "—"],
    ["Языки", info.languages || "—"],
    ["Экран", info.screen || "—"],
    ["Процессор · память", info.hardware || "—"],
    ["Ядро Chromium", info.chrome || "—"],
    ["Расширения", info.extensions || "Нет"],
    ["Защита WebRTC", "Прямой UDP заблокирован"],
    ["Cookies", info.cookies || "Подготовка"],
  ];
  const grid = document.getElementById("home-metrics");
  grid.replaceChildren(...metrics.map(([label, value]) => {
    const card = document.createElement("div"); card.className = "metric";
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    card.append(dt, dd); return card;
  }));
  const text = info.checking ? "Проверяем подключение…" : info.checkError || (info.checkedAt ? "Проверено: " + new Date(info.checkedAt).toLocaleString("ru-RU") : "IP проверяется через назначенный прокси");
  document.getElementById("home-check-status").textContent = info.hasProxy ? text : "Профиль использует прямое подключение";
  document.getElementById("check-connection").disabled = !info.hasProxy || info.checking;
  document.getElementById("home-session").textContent = info.startedAt ? "Сессия открыта: " + new Date(info.startedAt).toLocaleString("ru-RU") : "";
}
const homeMarkup = '<main id="home" hidden><div class="home-top"><div><span class="eyebrow">UMBRA / ПРОФИЛЬ</span><h1 id="home-name">Профиль</h1><p id="home-id" class="muted"></p></div><span class="session-badge">Сессия изолирована</span></div><form id="home-search"><input id="home-address" aria-label="Поиск в профиле" placeholder="Поиск или адрес сайта" autocomplete="off"><button type="submit">Открыть →</button></form><div class="home-section"><h2>Показатели профиля</h2><button id="check-connection" type="button">Проверить IP</button></div><p id="home-check-status" class="muted" role="status"></p><dl id="home-metrics"></dl><p id="home-session" class="muted"></p><p class="muted">Здесь показаны параметры этого профиля. Результат проверки IP обновляется по кнопке.</p></main>';
const homeStyle = '#home{position:absolute;top:var(--chrome-height,90px);bottom:0;left:0;right:0;overflow:auto;padding:clamp(20px,4vw,60px);background:radial-gradient(ellipse at 90% 0%,var(--accent) 0,transparent 45%),var(--background)}#home[hidden]{display:none}.home-top{display:flex;justify-content:space-between;align-items:start;gap:16px;max-width:1100px;margin:auto}.eyebrow{font-size:11px;letter-spacing:2px;color:var(--primary)}#home h1{font-size:30px;margin:12px 0 4px;overflow-wrap:anywhere}#home h2{font-size:17px;font-weight:500}.muted{color:var(--muted-foreground);font-size:12px;overflow-wrap:anywhere}.session-badge{font-size:11px;background:var(--secondary);border:1px solid var(--border);border-radius:20px;padding:7px 10px;white-space:nowrap;color:var(--success)}#home-search{display:flex;gap:12px;margin:28px auto;max-width:1100px}#home-search input{flex:1;min-width:0;height:46px;padding:0 16px;background:var(--secondary);border:1px solid var(--border);border-radius:10px}#home-search button{height:46px;background:var(--primary);color:var(--primary-foreground);padding:0 22px;border-radius:10px;font-weight:600}.home-section{display:flex;align-items:center;justify-content:space-between;max-width:1100px;margin:auto}#check-connection{border:1px solid var(--border);padding:0 12px}#home-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;max-width:1100px;margin:16px auto 24px}.metric{border:1px solid var(--border);border-radius:10px;background:var(--card);padding:18px;min-height:96px}dt{font-size:11px;color:var(--muted-foreground);margin-bottom:12px}dd{margin:0;font-size:15px;font-weight:500;overflow-wrap:anywhere}#home>p{max-width:1100px;margin:10px auto}#home-check-status{min-height:18px}@media(max-width:1000px){#home-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:700px){#home-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.session-badge{display:none}}';
module.exports = { renderHome, homeMarkup, homeStyle };
