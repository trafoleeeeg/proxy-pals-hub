import { z } from "zod";

export const PROXY_LIMITS = {
  importBytes: 256 * 1024,
  importLines: 500,
  lineLength: 4096,
  label: 200,
  host: 253,
  credentialBytes: 1024,
  rotationUrl: 2048,
} as const;

export type ProxyProtocol = "http" | "https" | "socks5";
export type PasswordAction = "preserve" | "replace" | "clear";
export type RotationAction = "preserve" | "replace" | "clear";
export type ProxyInput = {
  id?: string | undefined;
  teamId: string;
  label: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
  passwordAction?: PasswordAction | undefined;
  rotationUrl?: string | undefined;
  rotationAction?: RotationAction | undefined;
  country?: string | undefined;
};

export type ProxyFields = {
  label: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
  country: string;
};
export type ProxyImportIssue = { line: number; message: string };
export type ProxyCheckResult = {
  ok: boolean;
  ip?: string | undefined;
  country?: string | undefined;
  city?: string | undefined;
  latency?: number | undefined;
  error?: string | undefined;
};

export type ProxyRotationStatus = "not_configured" | "ready" | "changing" | "success" | "error";

const uuid = z.string().uuid();
const ip = z.string().ip();
const ipv6 = z.string().ip({ version: "v6" });
const encoder = new TextEncoder();
const controls = /[\u0000-\u001f\u007f]/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Некорректные параметры прокси");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, max: number, message: string, optional = false): string {
  if (value === undefined && optional) return "";
  if (typeof value !== "string" || value.length > max || controls.test(value)) {
    throw new Error(message);
  }
  return value;
}

/** Rotation links are provider endpoints, never local URLs or javascript/data URLs. */
export function validateRotationUrl(value: unknown, optional = true): string {
  if (value === undefined && optional) return "";
  const raw = string(value, PROXY_LIMITS.rotationUrl, "Ссылка смены IP слишком длинная", optional).trim();
  if (!raw) {
    if (!optional) throw new Error("Укажите ссылку смены IP");
    return "";
  }
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || !host || url.username || url.password ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
      host.startsWith("[") || /^127\./.test(host) || /^0\./.test(host) ||
      /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
      /^(?:198\.(?:18|19)\.|2[2-5]\d\.)/.test(host) ||
      /^169\.254\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) throw new Error();
    return url.toString();
  } catch {
    throw new Error("Ссылка смены IP должна быть безопасным HTTPS-адресом без логина и пароля");
  }
}

export function validateProxyTeam(value: unknown): { teamId: string } {
  const data = object(value);
  if (!uuid.safeParse(data["teamId"]).success) throw new Error("Некорректная команда");
  return { teamId: data["teamId"] as string };
}

export function validateProxyTarget(value: unknown): { id: string; teamId: string } {
  const data = object(value);
  if (!uuid.safeParse(data["id"]).success) throw new Error("Некорректный идентификатор прокси");
  return { ...validateProxyTeam(data), id: data["id"] as string };
}

export function validateProxyProtocol(value: unknown): ProxyProtocol {
  if (value !== "http" && value !== "https" && value !== "socks5") {
    throw new Error("Допустимые типы прокси: HTTP, HTTPS, SOCKS5");
  }
  return value;
}

export function normalizeProxyHost(value: unknown): string {
  let host = string(value, PROXY_LIMITS.host + 2, "Некорректный адрес прокси").trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
    if (!ipv6.safeParse(host).success) throw new Error("Некорректный IPv6-адрес");
  }
  if (host.includes(":")) {
    if (!ipv6.safeParse(host).success) throw new Error("Некорректный IPv6-адрес");
    return new URL(`http://[${host}]`).hostname.slice(1, -1);
  }
  if (!host || host.length > PROXY_LIMITS.host || /[\s/@\\?#%\[\]]/.test(host)) {
    throw new Error("Укажите адрес без протокола, порта и пути");
  }
  try {
    const normalized = new URL(`http://${host}`).hostname;
    if (!normalized || normalized.length > PROXY_LIMITS.host ||
      !normalized.replace(/\.$/, "").split(".").every((part) =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) throw new Error();
    return normalized.replace(/\.$/, "");
  } catch {
    throw new Error("Некорректный адрес прокси");
  }
}

export function proxyAddress(host: string, port: number | string): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export function parseProxyPort(value: unknown): number {
  if (typeof value === "string" && !/^\d{1,5}$/.test(value)) {
    throw new Error("Порт должен быть целым числом от 1 до 65535");
  }
  const port = typeof value === "string" ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Порт должен быть целым числом от 1 до 65535");
  }
  return port;
}

export function validateProxyFields(value: unknown): ProxyFields {
  const data = object(value);
  const protocol = validateProxyProtocol(data["protocol"]);
  const host = normalizeProxyHost(data["host"]);
  const port = parseProxyPort(data["port"]);
  const label = string(data["label"], PROXY_LIMITS.label, "Название: максимум 200 символов", true).trim();
  const username = string(data["username"], PROXY_LIMITS.credentialBytes, "Некорректный логин", true);
  const password = string(data["password"], PROXY_LIMITS.credentialBytes, "Некорректный пароль", true);
  if (password && !username) throw new Error("Укажите логин для прокси с паролем");
  const max = protocol === "socks5" ? 255 : PROXY_LIMITS.credentialBytes;
  if (encoder.encode(username).length > max || encoder.encode(password).length > max) {
    throw new Error(`Логин и пароль: максимум ${max} байт каждый`);
  }
  if (protocol !== "socks5" && username.includes(":")) {
    throw new Error("Логин HTTP-прокси не может содержать двоеточие");
  }
  const country = string(data["country"], 2, "Страна: двухбуквенный код", true).toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error("Страна: двухбуквенный код");
  return { label: label || proxyAddress(host, port), protocol, host, port, username, password, country };
}

export function validateProxyInput(value: unknown): ProxyInput & { passwordAction: PasswordAction } {
  const data = object(value);
  const fields = validateProxyFields(data);
  const team = validateProxyTeam(data);
  const id = data["id"] === undefined ? undefined : validateProxyTarget(data).id;
  const action = data["passwordAction"] ?? (fields.password ? "replace" : id ? "preserve" : "clear");
  if (action !== "preserve" && action !== "replace" && action !== "clear") {
    throw new Error("Некорректное действие с паролем");
  }
  if ((action === "replace" && !fields.password) || (action !== "replace" && fields.password)) {
    throw new Error("Выберите замену пароля и укажите новый пароль либо сохраните или удалите текущий");
  }
  const rotationAction = data["rotationAction"] ?? (id ? "preserve" : "clear");
  if (rotationAction !== "preserve" && rotationAction !== "replace" && rotationAction !== "clear") {
    throw new Error("Некорректное действие со ссылкой смены IP");
  }
  const rotationUrl = validateRotationUrl(data["rotationUrl"]);
  if (rotationAction === "replace" && !rotationUrl) throw new Error("Укажите ссылку смены IP");
  if (rotationAction !== "replace" && rotationUrl) throw new Error("Выберите замену ссылки смены IP или сохраните текущую");
  return { ...fields, ...team, ...(id ? { id } : {}), passwordAction: action, rotationAction, ...(rotationUrl ? { rotationUrl } : {}) };
}

export function parseProxyLine(line: string, defaultProtocol: ProxyProtocol = "http"): ProxyFields {
  validateProxyProtocol(defaultProtocol);
  if (line.length > PROXY_LIMITS.lineLength || controls.test(line)) throw new Error("Строка слишком длинная или содержит управляющие символы");
  const text = line.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  // In colon format credentials are literal, including @, %, colons and spaces.
  const match = !scheme && /^(\[[^\]]+\]|[^:@]+):(\d+)(?::([^:]*)(?::(.*))?)?\s*$/.exec(line.trimStart());
  if (match) {
    return validateProxyFields({
      protocol: defaultProtocol, host: match[1], port: match[2], username: match[3], password: match[4],
    });
  }
  if (scheme || text.includes("@")) {
    const protocol = scheme ? validateProxyProtocol(scheme[1]?.toLowerCase()) : defaultProtocol;
    try {
      const url = new URL(scheme ? text : `${protocol}://${text}`);
      if ((url.pathname && url.pathname !== "/") || url.search || url.hash || /\s/.test(text) || text.includes("\\")) {
        throw new Error();
      }
      // URL omits an explicit default port, so read the authority's port as well.
      const authority = text.slice(scheme?.[0].length ?? 0).replace(/\/$/, "");
      if (/[/?#]/.test(authority)) throw new Error();
      const endpoint = authority.slice(authority.lastIndexOf("@") + 1);
      const port = /:(\d+)$/.exec(endpoint)?.[1];
      return validateProxyFields({
        protocol, host: url.hostname, port,
        username: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      });
    } catch {
      throw new Error("Некорректный URL прокси: проверьте адрес, порт и кодирование логина/пароля");
    }
  }
  throw new Error("Ожидается host:port[:login:password]; IPv6 укажите в квадратных скобках");
}

/** A single proxy with an optional rotation link, as supplied by mobile-proxy vendors. */
export function parseProxyBundle(value: unknown): (ProxyFields & { rotationUrl: string }) | null {
  if (typeof value !== "string" || encoder.encode(value).length > PROXY_LIMITS.importBytes) return null;
  const lines = value.trim().split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 2) return null;
  const prefixed = /^(socks5|https?|socks)\s*:\s+(.*)$/i.exec(lines[0]!);
  const protocol = prefixed ? (prefixed[1]!.toLowerCase() === "socks" ? "socks5" : prefixed[1]!.toLowerCase()) as ProxyProtocol : "http";
  const endpoint = prefixed ? prefixed[2]! : lines[0]!;
  let rotationUrl = "";
  if (lines[1]) {
    const linked = /^\[https:\/\/[^\]]+\]\((https:\/\/[^)]+)\)$/.exec(lines[1]);
    const link = (linked?.[1] ?? lines[1]).replace(/\\([&_])/g, "$1");
    if (!/^https:\/\//i.test(link)) return null;
    // Two ordinary proxy URLs in a bulk import must not become a proxy plus
    // a rotation link merely because the second one uses HTTPS.
    if (!prefixed && /^https:\/\/[^/?#]+\/?$/.test(link)) return null;
    rotationUrl = validateRotationUrl(link, false);
  }
  try {
    const proxy = parseProxyLine(endpoint, protocol);
    return { ...proxy, rotationUrl };
  } catch {
    if (prefixed || lines[1]) throw new Error("Не удалось распознать адрес прокси. Проверьте формат host:port:login:password");
    return null;
  }
}

export function parseProxyImport(text: unknown, protocol: ProxyProtocol = "http"): {
  rows: ProxyFields[]; issues: ProxyImportIssue[];
} {
  validateProxyProtocol(protocol);
  if (typeof text !== "string" || text.length > PROXY_LIMITS.importBytes || encoder.encode(text).length > PROXY_LIMITS.importBytes) {
    throw new Error("Список прокси: максимум 256 КиБ");
  }
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > PROXY_LIMITS.importLines) throw new Error("Список прокси: максимум 500 строк");
  const rows: ProxyFields[] = [];
  const issues: ProxyImportIssue[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try { rows.push(parseProxyLine(line, protocol)); }
    catch (error) { issues.push({ line: index + 1, message: error instanceof Error ? error.message : "Некорректный прокси" }); }
  });
  if (!rows.length && !issues.length) throw new Error("Добавьте хотя бы один прокси");
  return { rows, issues };
}

export function normalizeProxyCheck(value: unknown): ProxyCheckResult {
  const data = object(value);
  if (typeof data["ok"] !== "boolean") throw new Error("Некорректный результат проверки");
  if (data["ok"] && !ip.safeParse(data["ip"]).success) throw new Error("Проверка не вернула корректный IP-адрес");
  const latency = data["latency"];
  if (latency !== undefined && (typeof latency !== "number" || !Number.isInteger(latency) || latency < 0 || latency > 120000)) {
    throw new Error("Некорректная задержка проверки");
  }
  const country = string(data["country"], 2, "Некорректная страна проверки", true).toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error("Некорректная страна проверки");
  const city = string(data["city"], 120, "Некорректный город проверки", true);
  // IPC/network errors may contain a credential-bearing URL. Never persist their raw text.
  return data["ok"]
    ? { ok: true, ip: data["ip"] as string, ...(country ? { country } : {}), ...(city ? { city } : {}), ...(latency !== undefined ? { latency: latency as number } : {}) }
    : { ok: false, error: "Прокси не прошёл проверку подключения", ...(latency !== undefined ? { latency: latency as number } : {}) };
}

export const DESKTOP_PROXY_CHECK_REQUIRED = {
  status: "desktop_required", supported: false, ok: null,
  error: "Проверка прокси доступна в настольном приложении",
} as const;

export async function performDesktopProxyCheck<T>(api: {
  load: () => Promise<T>;
  check: (target: T) => Promise<{ ok: boolean; result?: ProxyCheckResult | undefined }>;
  record: (result: ProxyCheckResult) => Promise<unknown>;
}): Promise<ProxyCheckResult> {
  let target: T;
  try { target = await api.load(); }
  catch { throw new Error("Не удалось получить прокси для проверки. Проверьте доступ и подключение"); }
  let response: { ok: boolean; result?: ProxyCheckResult | undefined };
  try { response = await api.check(target); }
  catch { throw new Error("Приложение не выполнило проверку. Повторите попытку или обновите приложение"); }
  if (!response?.ok || !response.result) {
    throw new Error("Приложение не выполнило проверку. Повторите попытку или обновите приложение");
  }
  const result = normalizeProxyCheck(response.result);
  try { await api.record(result); }
  catch { throw new Error("Проверка завершена, но результат не сохранён. Повторите попытку"); }
  return result;
}

/** One queue for both individual and bulk checks, including rapid repeated clicks. */
export class ProxyCheckQueue {
  private jobs = new Map<string, Promise<unknown>>();
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private limit = 3) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Некорректный лимит проверок");
  }

  run<T>(id: string, check: () => Promise<T>): Promise<T> {
    const previous = this.jobs.get(id);
    if (previous) return previous as Promise<T>;
    const job = (async () => {
      if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
      else this.active++;
      try { return await check(); }
      finally {
        const next = this.waiting.shift();
        if (next) next();
        else this.active--;
      }
    })();
    this.jobs.set(id, job);
    void job.finally(() => { this.jobs.delete(id); }).catch(() => {});
    return job;
  }
}
