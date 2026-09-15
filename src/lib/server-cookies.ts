import { z } from "zod";
import { cookiesTextSchema } from "./server-validation";

const cookieSchema = z.object({
  name: z.string().max(4096).refine((s) => !/[\x00-\x20\x7f;,=]/.test(s)),
  value: z.string().max(65536).refine((s) => !/[\x00-\x1f\x7f]/.test(s)),
  domain: z.string().min(1).max(253).refine((s) => /^(\.?[a-zA-Z0-9_-]+)(\.[a-zA-Z0-9_-]+)*$/.test(s)),
  path: z.string().max(4096).startsWith("/").default("/"),
  secure: z.boolean().default(false), httpOnly: z.boolean().default(false),
  hostOnly: z.boolean().optional(), session: z.boolean().optional(),
  expirationDate: z.number().finite().min(0).max(253402300799).optional(),
  sameSite: z.enum(["unspecified", "no_restriction", "lax", "strict"]).optional(),
}).strip();
export type ProfileCookie = z.infer<typeof cookieSchema>;

/** Normalize common browser exports; errors never include cookie values. */
export function parseCookieImport(text: string): ProfileCookie[] {
  cookiesTextSchema.parse(text);
  const source = text.trim();
  let raw: unknown;
  try {
    if (source.startsWith("[") || source.startsWith("{")) {
      const parsed: unknown = JSON.parse(source);
      raw = Array.isArray(parsed) ? parsed : (parsed as { cookies?: unknown } | null)?.cookies;
    } else {
      raw = source.split(/\r?\n/).flatMap((line, index) => {
        if (!line.trim() || (line.startsWith("#") && !line.startsWith("#HttpOnly_"))) return [];
        const httpOnly = line.startsWith("#HttpOnly_");
        const fields = (httpOnly ? line.slice(10) : line).split("\t");
        if (fields.length !== 7 || !["TRUE", "FALSE"].includes(fields[1]!) || !["TRUE", "FALSE"].includes(fields[3]!) || !/^\d+$/.test(fields[4]!)) {
          throw new Error(`Invalid Netscape cookie on line ${index + 1}`);
        }
        const [domain, subdomains, path, secure, expires, name, value] = fields;
        return [{ domain, path, name, value, secure: secure === "TRUE", httpOnly,
          hostOnly: subdomains === "FALSE", session: Number(expires) === 0,
          ...(Number(expires) > 0 ? { expirationDate: Number(expires) } : {}),
        }];
      });
    }
  } catch {
    throw new Error("Invalid cookie import format");
  }
  if (!Array.isArray(raw) || raw.length > 10000 || (!source && raw.length === 0)) throw new Error("Invalid cookie collection");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Invalid cookie at position ${index + 1}`);
    const value = { ...item };
    if (value.sameSite === "None" || value.sameSite === "none") value.sameSite = "no_restriction";
    if (value.sameSite === "Lax") value.sameSite = "lax";
    if (value.sameSite === "Strict") value.sameSite = "strict";
    const result = cookieSchema.safeParse(value);
    if (!result.success) throw new Error(`Invalid cookie at position ${index + 1}`);
    const cookie = result.data;
    if (cookie.session) delete cookie.expirationDate;
    return cookie;
  });
}
