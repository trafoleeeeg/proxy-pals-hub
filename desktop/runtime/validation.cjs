const { isIP } = require("node:net");

function profileId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("Invalid profile UUID");
  return value.toLowerCase();
}

function revision(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid cookie revision");
  return new Date(value).toISOString();
}

function startUrl(value, { allowBlank = false } = {}) {
  if (allowBlank && value === "about:blank") return value;
  if (typeof value !== "string" || value.length > 8192) throw new Error("Invalid start URL");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid start URL"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error("Only HTTP(S) URLs without credentials are allowed");
  return url.href;
}

// Букмарклеты (javascript:) запускаются как скрипт на текущей вкладке и
// никогда не открываются навигацией, поэтому правила отличаются от startUrl.
function bookmarkletUrl(value) {
  if (typeof value !== "string" || !value.startsWith("javascript:") || value.length > 200000 || /[\r\n\0]/.test(value)) throw new Error("Invalid bookmarklet");
  return value;
}

function proxyConfig(value) {
  if (!value || typeof value !== "object") throw new Error("Proxy configuration is required");
  const { protocol, port } = value;
  if (!["http", "https", "socks5"].includes(protocol)) throw new Error("Unsupported proxy protocol");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid proxy port");
  const host = typeof value.host === "string" ? value.host.replace(/^\[([^\]]+)\]$/, "$1") : "";
  if (!isIP(host) && (host.length > 253 || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.split(".").some((label) => !label || label.length > 63 || /^-|-$/.test(label)))) throw new Error("Invalid proxy host");
  const username = value.username ?? "";
  const password = value.password ?? "";
  if (typeof username !== "string" || typeof password !== "string" || username.length > 1024 || password.length > 1024 || /[\r\n\0]/.test(username + password) || (password && !username)) throw new Error("Invalid proxy credentials");
  if (protocol === "socks5" && (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255)) throw new Error("SOCKS5 credentials exceed protocol limits");
  // socks5h delegates target DNS resolution to the upstream proxy.
  const url = new URL(`${protocol === "socks5" ? "socks5h" : protocol}://${isIP(host) === 6 ? `[${host}]` : host}:${port}`);
  url.username = username;
  url.password = password;
  return { protocol, url: url.href, authenticated: !!username };
}

module.exports = { profileId, revision, startUrl, bookmarkletUrl, proxyConfig };
