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
const WINDOWS_VERSIONS = ["10.0", "11.0"];
const SCREENS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1366, height: 768 },
  { width: 2560, height: 1440 },
  { width: 1440, height: 900 },
];
const GPUS = [
  {
    vendor: "Google Inc. (NVIDIA)",
    renderer:
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (NVIDIA)",
    renderer:
      "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (AMD)",
    renderer: "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (Intel)",
    renderer:
      "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    vendor: "Google Inc. (Intel)",
    renderer:
      "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
];
const CORES = [4, 6, 8, 12, 16];
const MEMORY = [4, 8];
const FONT_PRESETS = ["Windows 10 базовый", "Windows 11 базовый", "Windows + MS Office"];
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

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

export function generateFingerprint(country?: string | null, os: FingerprintOS = "windows"): Fingerprint {
  const chromeVersion = pick(CHROME_VERSIONS);
  const mac = os === "macos" ? pick(MAC_DEVICES) : null;
  const osVersion = mac ? pick(["14.0.0", "15.0.0"]) : pick(WINDOWS_VERSIONS);
  const screen = mac?.screen ?? pick(SCREENS);
  const gpu = mac ? { vendor: "Google Inc. (Apple)", renderer: mac.renderer } : pick(GPUS);
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
    hardwareConcurrency: mac?.cores ?? pick(CORES),
    deviceMemory: mac ? 8 : pick(MEMORY),
    language: locale.language,
    languages: [locale.language, locale.language.split("-")[0] ?? "en"],
    timezone: locale.timezone,
    fontsPreset: mac ? "macOS базовый" : pick(FONT_PRESETS),
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
  const os = fp.os === "macos" ? `macOS ${fp.osVersion?.split(".")[0] ?? ""}` : `Windows ${fp.osVersion === "11.0" ? "11" : "10"}`;
  return `${os} · Chrome ${fp.chromeVersion.split(".")[0]} · ${fp.screen?.width}x${fp.screen?.height} · ${fp.timezone}`;
}
