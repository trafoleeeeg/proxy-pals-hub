import type { Fingerprint } from "@/lib/fingerprint";

export type ProfileChanges = { folder?: string; tags?: string[]; notes?: string; proxyId?: string | null; fingerprint?: Fingerprint };
export const splitTags = (value: string) => [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];

export function toggleVisibleSelection(selected: string[], visible: string[], checked: boolean): string[] {
  const visibleSet = new Set(visible);
  return checked ? [...new Set([...selected, ...visible])] : selected.filter((id) => !visibleSet.has(id));
}

export function fingerprintError(fp: Fingerprint): string | null {
  try { new Intl.DateTimeFormat("en", { timeZone: fp.timezone }).format(); }
  catch { return "Укажите действительный часовой пояс IANA."; }
  try {
    if (!fp.language.trim() || !fp.languages.length) return "Укажите язык профиля.";
    Intl.getCanonicalLocales([fp.language, ...fp.languages]);
  } catch { return "Укажите язык в формате ru-RU или en-US."; }
  if (fp.languages[0] !== fp.language) return "Основной язык должен быть первым в списке языков.";
  if (!Number.isInteger(fp.screen?.width) || fp.screen.width < 320 || fp.screen.width > 7680 ||
      !Number.isInteger(fp.screen?.height) || fp.screen.height < 240 || fp.screen.height > 4320) return "Размер экрана: 320–7680 × 240–4320.";
  if (!Number.isInteger(fp.hardwareConcurrency) || fp.hardwareConcurrency < 1 || fp.hardwareConcurrency > 128) return "Количество ядер: от 1 до 128.";
  if (![1, 2, 4, 8].includes(fp.deviceMemory)) return "Выберите объём памяти: 1, 2, 4 или 8 ГБ.";
  if (!fp.userAgent.trim() || fp.userAgent.length > 1024 || /[\r\n\0]/.test(fp.userAgent)) return "Укажите корректный User-Agent до 1024 символов без переносов строк.";
  if (!fp.userAgent.includes("Windows NT 10.0")) return "Для Windows 10 и 11 User-Agent должен содержать Windows NT 10.0.";
  if (fp.startUrl) {
    try { const url = new URL(fp.startUrl); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "Стартовый адрес: HTTP или HTTPS без учётных данных."; }
    catch { return "Укажите полный стартовый адрес HTTP или HTTPS."; }
  }
  return null;
}

export function profileFingerprintPayload(fp: Fingerprint): Fingerprint {
  const { startUrl, ...settings } = fp;
  return startUrl?.trim() ? { ...settings, startUrl: startUrl.trim() } : settings;
}

export function cookiesToNetscape(json: string): string {
  const cookies: unknown = JSON.parse(json);
  if (!Array.isArray(cookies)) throw new Error("Некорректный формат cookies.");
  const lines = cookies.map((cookie: Record<string, unknown>) => {
    if (!cookie || typeof cookie["domain"] !== "string" || typeof cookie["name"] !== "string" || typeof cookie["value"] !== "string") throw new Error("Некорректный формат cookies.");
    const domain = cookie["domain"];
    const path = typeof cookie["path"] === "string" ? cookie["path"] : "/";
    const name = cookie["name"];
    const value = cookie["value"];
    if ([domain, path, name, value].some((field) => /[\t\r\n]/.test(field))) throw new Error("Эти cookies нельзя представить в Netscape. Выберите JSON.");
    const expiry = cookie["expirationDate"] ?? cookie["expires"];
    return [cookie["httpOnly"] ? `#HttpOnly_${domain}` : domain,
      cookie["hostOnly"] === true ? "FALSE" : cookie["hostOnly"] === false || domain.startsWith(".") ? "TRUE" : "FALSE",
      path, cookie["secure"] ? "TRUE" : "FALSE",
      cookie["session"] || typeof expiry !== "number" || !Number.isFinite(expiry) || expiry < 0 ? "0" : String(Math.floor(expiry)),
      name, value].join("\t");
  });
  return ["# Netscape HTTP Cookie File", ...lines, ""].join("\n");
}
