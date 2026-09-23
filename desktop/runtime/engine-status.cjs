const ELECTRON_LATEST = "https://registry.npmjs.org/electron/latest";
const CHROME_STABLE = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json";

function stableVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid engine version");
  return value;
}

function compareVersions(left, right) {
  const a = stableVersion(left).split(".").map(Number);
  const b = stableVersion(right).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
  }
  return 0;
}

async function boundedJson(fetcher, url) {
  const response = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("Version source unavailable");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Version source returned no data");
  const decoder = new TextDecoder();
  let value = "";
  for (;;) {
    const { done, value: bytes } = await reader.read();
    if (done) break;
    value += decoder.decode(bytes, { stream: true });
    if (value.length > 65536) { await reader.cancel(); throw new Error("Version response is too large"); }
  }
  value += decoder.decode();
  return JSON.parse(value);
}

async function checkEngineVersions({ fetcher = fetch, installedElectron = process.versions.electron, installedChromium = process.versions.chrome } = {}) {
  stableVersion(installedElectron);
  stableVersion(installedChromium);
  const [electron, chrome] = await Promise.all([
    boundedJson(fetcher, ELECTRON_LATEST),
    boundedJson(fetcher, CHROME_STABLE),
  ]);
  const latestElectron = stableVersion(electron.version);
  const stableChrome = stableVersion(chrome.channels?.Stable?.version);
  return {
    installedElectron, installedChromium, latestElectron, stableChrome,
    electronUpdateAvailable: compareVersions(latestElectron, installedElectron) > 0,
    chromeMajorAhead: Number(stableChrome.split(".")[0]) > Number(installedChromium.split(".")[0]),
  };
}

module.exports = { checkEngineVersions, compareVersions };
