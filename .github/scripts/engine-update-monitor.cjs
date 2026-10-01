const assert = require('node:assert/strict');
const fs = require('node:fs');

const marker = '<!-- umbra-engine-update-watch -->';
const electronSource = 'https://registry.npmjs.org/electron/latest';
const chromeSource = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json';

function parts(value) {
  assert.equal(typeof value, 'string');
  assert(/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value), 'Expected a stable numeric engine version');
  return value.split('.').map(Number);
}

function compare(left, right) {
  const a = parts(left), b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

function plan(packageJson, lock, latestElectron, stableChrome) {
  const pinnedElectron = lock.electron?.tag?.replace(/^v/, '');
  const pinnedChrome = lock.chromium?.tag;
  assert.equal(packageJson.devDependencies?.electron, pinnedElectron,
    'Package Electron differs from the pinned custom engine');
  parts(pinnedElectron);
  parts(pinnedChrome);
  parts(latestElectron);
  parts(stableChrome);
  return {
    pinnedElectron, pinnedChrome, latestElectron, stableChrome,
    electronBehind: compare(latestElectron, pinnedElectron) > 0,
    chromeBehind: compare(stableChrome, pinnedChrome) > 0,
  };
}

function issueFor(update) {
  const title = 'Движок Umbra: проверить Electron ' + update.latestElectron +
    ' (Chrome Stable ' + update.stableChrome + ' — ориентир)';
  const body = [
    marker,
    'Umbra сейчас выпускается с Electron **' + update.pinnedElectron +
      '** и встроенным Chromium **' + update.pinnedChrome + '**. Последний стабильный Electron: **' +
      update.latestElectron + '**. Отдельный Chrome Stable: **' + update.stableChrome + '**.',
    'Версия отдельного Chrome не является версией Chromium внутри Electron. Её нельзя подставлять ' +
      'в сборку Electron: точные Chromium и Node нужно брать из DEPS выбранного тега Electron.',
    'Новая npm-зависимость не обновляет закреплённый движок Umbra и не должна выпускаться отдельно от нового нативного архива.',
    '- [ ] Проверить стабильный Electron и версии его Chromium/Node по DEPS: https://github.com/electron/electron/releases/tag/v' + update.latestElectron,
    '- [ ] Перенести патчи из desktop/engine/ на новые исходники Electron/Chromium.',
    '- [ ] Собрать Windows-движок и пройти нативные screen, hardware, fonts, DNS и network-тесты.',
    '- [ ] Опубликовать тестовый ZIP движка; закрепить SHA-256 и точные исходные коммиты в desktop/engine/source-lock.json.',
    '- [ ] Обновить Electron и lockfile одновременно с движком через PR; дождаться зелёного CI.',
    '- [ ] Выпустить клиент отдельным тегом после проверки установщика и автообновления.',
    'Источники: https://www.npmjs.com/package/electron и https://googlechromelabs.github.io/chrome-for-testing/.',
  ].join('\n\n') + '\n';
  return { title, body };
}

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Version/GitHub request failed: ' + response.status);
  return response.status === 204 ? null : response.json();
}

async function run() {
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Watch only the default branch');
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository || '') && token, 'Missing GitHub repository or token');
  const packageJson = JSON.parse(fs.readFileSync('desktop/package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('desktop/engine/source-lock.json', 'utf8'));
  const [electron, chrome] = await Promise.all([json(electronSource), json(chromeSource)]);
  const update = plan(packageJson, lock, electron.version, chrome.channels?.Stable?.version);
  const apiRoot = 'https://api.github.com/repos/' + repository;
  const api = (path, method = 'GET', body) => json(apiRoot + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const candidates = [];
  for (let page = 1; page <= 10; page++) {
    const issues = await api('/issues?state=open&per_page=100&page=' + page);
    candidates.push(...issues.filter((issue) => !issue.pull_request && issue.body?.includes(marker)));
    if (issues.length < 100) break;
    assert(page < 10, 'Too many open issues to identify the engine watch issue');
  }
  assert(candidates.length <= 1, 'Multiple engine watch issues exist');
  const existing = candidates[0];
  if (existing) assert.equal(existing.user.login, 'github-actions[bot]', 'Refusing to edit a human issue');
  let message;
  if (update.electronBehind || update.chromeBehind) {
    const expected = issueFor(update);
    if (!existing) {
      const created = await api('/issues', 'POST', expected);
      message = 'Найдено обновление движка: ' + created.html_url;
    } else if (existing.title !== expected.title || existing.body !== expected.body) {
      await api('/issues/' + existing.number, 'PATCH', expected);
      message = 'Обновлена задача по движку: ' + existing.html_url;
    } else message = 'Обновление уже отслеживается: ' + existing.html_url;
  } else if (existing) {
    message = 'Версии движка актуальны; проверьте оставшиеся пункты и закройте задачу после релиза: ' +
      existing.html_url;
  } else message = 'Движок актуален: Electron ' + update.pinnedElectron +
    ', Chromium ' + update.pinnedChrome + '.';
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n');
}

if (require.main === module) run().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { compare, plan, issueFor, marker };
