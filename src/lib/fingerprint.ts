export type FingerprintOS = "windows" | "macos";
export type Fingerprint = {
  os: FingerprintOS;
  architecture?: "x86" | "arm";
  osVersion: string;
  chromeVersion: string;
  userAgent: string;
  platform: string;
  screen: { width: number; height: number; colorDepth: number };
  gpu: { vendor: string; renderer: string };
  hardwareConcurrency: number;
  deviceMemory: number;
  language: string;
  languages: string[];
  timezone: string;
  fontsPreset: string;
  canvasNoise: number;
  webglNoise: number;
  audioNoise: number;
  webrtc: "disabled" | "proxy";
  doNotTrack: boolean;
  // Older profiles have no setting and continue using the strict mode.
  aggressivePrivacyMode?: boolean;
  startUrl?: string;
};

const CHROME_VERSIONS = ["152.0.7977.78"];
// Bundles cover supported scalar settings, not emulated physical devices.
// Never label a random GPU/font set as if the stock engine implemented it.
export const WINDOWS_CONFIGURATIONS = [
  { id: "win10-compact", label: "Windows 10 · 1366×768 · 4 потока · 4 ГБ", osVersion: "10.0", width: 1366, height: 768, cores: 4, memory: 4 },
  { id: "win10-fullhd", label: "Windows 10 · 1920×1080 · 8 потоков · 8 ГБ", osVersion: "10.0", width: 1920, height: 1080, cores: 8, memory: 8 },
  { id: "win11-fullhd", label: "Windows 11 · 1920×1080 · 8 потоков · 8 ГБ", osVersion: "11.0", width: 1920, height: 1080, cores: 8, memory: 8 },
  { id: "win11-qhd", label: "Windows 11 · 2560×1440 · 16 потоков · 8 ГБ", osVersion: "11.0", width: 2560, height: 1440, cores: 16, memory: 8 },
] as const;

export function windowsUserAgent(chromeVersion: string): string {
  const major = /^\d+/.exec(chromeVersion)?.[0] ?? CHROME_VERSIONS[0]!.split(".")[0];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function applyWindowsConfiguration(fp: Fingerprint, id: string): Fingerprint {
  const config = WINDOWS_CONFIGURATIONS.find((item) => item.id === id);
  if (!config) return fp;
  return { ...fp, os: "windows", architecture: "x86", osVersion: config.osVersion,
    platform: "Win32", userAgent: windowsUserAgent(fp.chromeVersion),
    screen: { width: config.width, height: config.height, colorDepth: 24 },
    hardwareConcurrency: config.cores, deviceMemory: config.memory,
    gpu: { vendor: "", renderer: "" }, fontsPreset: "Нативные шрифты (не эмулируются)",
  };
}

export function windowsConfigurationId(fp: Fingerprint): string {
  return WINDOWS_CONFIGURATIONS.find((item) => fp.os === "windows" && fp.architecture !== "arm" &&
    Number.parseInt(fp.osVersion, 10) === Number.parseInt(item.osVersion, 10) && fp.screen?.colorDepth === 24 &&
    fp.screen.width === item.width && fp.screen.height === item.height &&
    fp.hardwareConcurrency === item.cores && fp.deviceMemory === item.memory)?.id ?? "custom";
}
// Keep screen, GPU and CPU families together instead of mixing Mac and Windows hardware.
const MAC_DEVICES = [
  { architecture: "arm" as const, cores: 8, screen: { width: 1440, height: 900 }, renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)" },
  { architecture: "arm" as const, cores: 8, screen: { width: 1470, height: 956 }, renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)" },
  { architecture: "arm" as const, cores: 10, screen: { width: 1512, height: 982 }, renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)" },
];

/** Соответствие страны прокси -> язык и часовой пояс, чтобы отпечаток был правдоподобным. */
export const COUNTRY_LOCALES: Record<string, { language: string; timezone: string; label: string }> = {
  US: { language: "en-US", timezone: "America/New_York", label: "США" },
  GB: { language: "en-GB", timezone: "Europe/London", label: "Великобритания" },
  DE: { language: "de-DE", timezone: "Europe/Berlin", label: "Германия" },
  FR: { language: "fr-FR", timezone: "Europe/Paris", label: "Франция" },
  ES: { language: "es-ES", timezone: "Europe/Madrid", label: "Испания" },
  IT: { language: "it-IT", timezone: "Europe/Rome", label: "Италия" },
  NL: { language: "nl-NL", timezone: "Europe/Amsterdam", label: "Нидерланды" },
  PL: { language: "pl-PL", timezone: "Europe/Warsaw", label: "Польша" },
  UA: { language: "uk-UA", timezone: "Europe/Kyiv", label: "Украина" },
  KZ: { language: "ru-KZ", timezone: "Asia/Almaty", label: "Казахстан" },
  RU: { language: "ru-RU", timezone: "Europe/Moscow", label: "Россия" },
  TR: { language: "tr-TR", timezone: "Europe/Istanbul", label: "Турция" },
  BR: { language: "pt-BR", timezone: "America/Sao_Paulo", label: "Бразилия" },
  CA: { language: "en-CA", timezone: "America/Toronto", label: "Канада" },
  AU: { language: "en-AU", timezone: "Australia/Sydney", label: "Австралия" },
  IN: { language: "en-IN", timezone: "Asia/Kolkata", label: "Индия" },
};

/** Never offer an old mobile-proxy location as a current fingerprint setting. */
export function verifiedProxyTimezone(proxy: {
  last_check_ok: boolean | null;
  last_checked_at: string | null;
  last_check_ip: string | null;
  geoTimezone: string | null;
} | null | undefined, now = Date.now()): string | null {
  if (!proxy?.last_check_ok || !proxy.last_check_ip || !proxy.geoTimezone) return null;
  const checked = Date.parse(proxy.last_checked_at ?? "");
  if (!Number.isFinite(checked) || checked > now + 5 * 60_000 || now - checked > 15 * 60_000) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: proxy.geoTimezone }); }
  catch { return null; }
  return proxy.geoTimezone;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

export function generateFingerprint(country?: string | null, os: FingerprintOS = "windows"): Fingerprint {
  const chromeVersion = pick(CHROME_VERSIONS);
  const mac = os === "macos" ? pick(MAC_DEVICES) : null;
  const windows = pick(WINDOWS_CONFIGURATIONS);
  const osVersion = mac ? pick(["14.0.0", "15.0.0"]) : windows.osVersion;
  const screen = mac?.screen ?? { width: windows.width, height: windows.height };
  const gpu = mac ? { vendor: "Google Inc. (Apple)", renderer: mac.renderer } : { vendor: "", renderer: "" };
  const locale = (country && COUNTRY_LOCALES[country.toUpperCase()]) || COUNTRY_LOCALES["US"]!;
  const major = chromeVersion.split(".")[0];

  return {
    os,
    architecture: mac?.architecture ?? "x86",
    osVersion,
    chromeVersion,
    userAgent: `Mozilla/5.0 (${mac ? "Macintosh; Intel Mac OS X 10_15_7" : "Windows NT 10.0; Win64; x64"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    platform: mac ? "MacIntel" : "Win32",
    screen: { ...screen, colorDepth: 24 },
    gpu,
    hardwareConcurrency: mac?.cores ?? windows.cores,
    deviceMemory: mac ? 8 : windows.memory,
    language: locale.language,
    languages: [locale.language, locale.language.split("-")[0] ?? "en"],
    timezone: locale.timezone,
    fontsPreset: mac ? "macOS базовый" : "Нативные шрифты (не эмулируются)",
    canvasNoise: Math.round(Math.random() * 1e6),
    webglNoise: Math.round(Math.random() * 1e6),
    audioNoise: Math.round(Math.random() * 1e6),
    webrtc: "proxy",
    doNotTrack: false,
    aggressivePrivacyMode: false,
  };
}

export function describeFingerprint(fp: Partial<Fingerprint>): string {
  if (!fp?.chromeVersion) return "Отпечаток не задан";
  const os = fp.os === "macos" ? `macOS ${fp.osVersion?.split(".")[0] ?? ""}` : `Windows ${Number.parseInt(fp.osVersion ?? "10", 10) === 11 ? "11" : "10"}`;
  return `${os} · Chrome ${fp.chromeVersion.split(".")[0]} · ${fp.screen?.width}x${fp.screen?.height} · ${fp.timezone}`;
}
