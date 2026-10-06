import { z } from "zod";
import { windowsUserAgent, type Fingerprint } from "./fingerprint";
import { isSupportedProfileMemory } from "./fingerprint-memory";

export const MAX_MIGRATION_BYTES = 16_384;
// Run only by the user in their source Windows profile's DevTools console.
// Reads public browser APIs; never reads storage, cookies or account data.
export const MIGRATION_PROBE = `copy(JSON.stringify({
  format: "umbra-settings-v1", os: "windows",
  screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
  hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory,
  languages: [...navigator.languages], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  userAgent: navigator.userAgent
}, null, 2))`;
// Public settings only. Never accept a full browser export or credentials here.
const migrationSchema = z.object({
  format: z.literal("umbra-settings-v1"),
  os: z.literal("windows"),
  osVersion: z.enum(["10", "11"]).optional(),
  screen: z.object({ width: z.number().int().min(320).max(7680), height: z.number().int().min(240).max(4320),
    colorDepth: z.number().int().min(8).max(48).optional() }).strict().optional(),
  hardwareConcurrency: z.number().int().min(1).max(128).optional(),
  physicalMemoryGB: z.number().finite().positive().max(1024).optional(),
  deviceMemory: z.number().finite().positive().max(1024).optional(),
  languages: z.union([z.literal("ip"), z.array(z.string().min(1).max(64)).min(1).max(10)]).optional(),
  timezone: z.string().min(1).max(128).optional(),
  userAgent: z.string().min(1).max(1024).refine(v => !/[\r\n\0]/.test(v)).optional(),
  gpuRenderer: z.string().min(1).max(256).optional(),
  fontCount: z.number().int().min(0).max(10_000).optional(),
  webrtc: z.enum(["ip", "disabled", "disable-unproxied-udp", "real"]).optional(),
  noise: z.object({ webgl: z.boolean(), canvas: z.boolean(), audio: z.boolean(), clientRects: z.boolean() }).strict().optional(),
}).strict();

export type MigrationSettings = z.infer<typeof migrationSchema>;
export type MigrationRow = { parameter: string; status: "apply" | "warning" | "unchanged"; detail: string };

export const TG_CHANNEL_SETTINGS: MigrationSettings = {
  format: "umbra-settings-v1", os: "windows", osVersion: "11",
  screen: { width: 1600, height: 900 }, hardwareConcurrency: 12, physicalMemoryGB: 32,
  languages: "ip", timezone: "ip", webrtc: "ip", gpuRenderer: "NVIDIA GeForce RTX 4060", fontCount: 154,
  noise: { webgl: false, canvas: false, audio: false, clientRects: false },
};

export function parseMigrationSettings(text: string): MigrationSettings {
  if (new TextEncoder().encode(text).length > MAX_MIGRATION_BYTES) throw new Error("Файл настроек превышает 16 КБ.");
  let source: unknown;
  try { source = JSON.parse(text); } catch { throw new Error("Нужен JSON настроек по показанному образцу, не cookies и не файл .octo."); }
  const parsed = migrationSchema.safeParse(source);
  if (!parsed.success) throw new Error("Неверные или неизвестные поля. Используйте образец; cookies, токены и пароли сюда не добавляйте.");
  const result = parsed.data;
  if (Array.isArray(result.languages)) {
    try { result.languages = Intl.getCanonicalLocales(result.languages); }
    catch { throw new Error("Некорректный список языков."); }
  }
  if (result.timezone && result.timezone !== "ip") {
    try { new Intl.DateTimeFormat("en", { timeZone: result.timezone }); }
    catch { throw new Error("Некорректный часовой пояс."); }
  }
  return result;
}

export function previewMigration(current: Fingerprint, source: MigrationSettings): { fingerprint: Fingerprint; rows: MigrationRow[] } {
  // No changes to cookies, proxy, start URL, noise seeds or privacy policy.
  const fingerprint: Fingerprint = { ...current, os: "windows", architecture: "x86", platform: "Win32",
    osVersion: source.osVersion ? `${source.osVersion}.0` : current.os === "windows" ? current.osVersion : "10.0",
    userAgent: windowsUserAgent(current.chromeVersion), screen: { ...current.screen }, languages: [...current.languages],
    gpu: { ...current.gpu },
  };
  const rows: MigrationRow[] = [];
  const row = (parameter: string, status: MigrationRow["status"], detail: string) => rows.push({ parameter, status, detail });
  row("ОС", source.osVersion ? "apply" : "warning", source.osVersion ? `Windows ${source.osVersion}` : "Версия Windows не указана; выбранную версию нужно проверить.");
  if (source.screen) {
    fingerprint.screen = { width: source.screen.width, height: source.screen.height,
      colorDepth: source.screen.colorDepth ?? current.screen.colorDepth };
    row("Экран", "apply", `${source.screen.width}×${source.screen.height}; глубина цвета ${source.screen.colorDepth ?? current.screen.colorDepth} бит${source.screen.colorDepth ? "" : " (оставлена текущая)"}. DPI и доступная область этим файлом не переносятся.`);
  }
  if (source.hardwareConcurrency != null) {
    fingerprint.hardwareConcurrency = source.hardwareConcurrency;
    row("CPU", "apply", `${source.hardwareConcurrency} логических потоков; модель и производительность CPU не эмулируются.`);
  }
  if (source.deviceMemory != null && isSupportedProfileMemory(source.deviceMemory)) {
    fingerprint.deviceMemory = source.deviceMemory;
    row("Память API", "apply", `${source.deviceMemory} ГБ — значение navigator.deviceMemory, не физическая RAM.`);
  } else {
    row("Память API", "warning", `${source.deviceMemory != null ? `Источник сообщает ${source.deviceMemory} ГБ: текущий движок поддерживает только 2/4/8.` : `Фактическое navigator.deviceMemory источника неизвестно${source.physicalMemoryGB ? `; ${source.physicalMemoryGB} ГБ в настройках не доказывают его значение` : ""}.`} Оставлено ${current.deviceMemory} ГБ; совпадение не подтверждено.`);
  }
  if (Array.isArray(source.languages)) {
    fingerprint.languages = [...source.languages]; fingerprint.language = source.languages[0]!;
    row("Языки", "apply", source.languages.join(", "));
  } else row("Языки", "warning", "Режим «от IP» не содержит фактический список языков. Оставлены текущие; укажите languages из работающего исходного профиля.");
  if (source.timezone && source.timezone !== "ip") {
    fingerprint.timezone = source.timezone; row("Часовой пояс", "apply", source.timezone);
  } else row("Часовой пояс", "warning", "Режим «от IP» не содержит фактический пояс. Оставлен текущий; укажите timezone исходного профиля.");
  row("User-Agent", "warning", `Версия останется согласованной с установленным Chromium Umbra.${source.userAgent ? " Строка источника не подставляется; её совпадение не подтверждено." : " Полная строка источника не указана."}`);
  row("WebRTC", "warning", `Источник: ${source.webrtc ?? "не указан"}. Политика Umbra сохраняется; «от IP» не равнозначно запрету прямого UDP.`);
  row("GPU / Canvas / Audio", "warning", `${source.gpuRenderer ? `Источник: ${source.gpuRenderer}. ` : ""}Поведение графики и аудио не переносится.${source.noise ? " Флаги шума не означают одинаковый результат двух движков." : ""}`);
  row("Шрифты / устройства", "warning", `${source.fontCount != null ? `${source.fontCount} шрифта у источника не определяют их состав. ` : ""}Набор шрифтов, медиоустройства и их идентификаторы не воспроизводятся.`);
  row("Защита и данные", "unchanged", "Режимы защиты, изоляция шрифтов, cookies, прокси и стартовый адрес не меняются. Local Storage / IndexedDB / Service Workers этим способом не переносятся.");
  return { fingerprint, rows };
}
