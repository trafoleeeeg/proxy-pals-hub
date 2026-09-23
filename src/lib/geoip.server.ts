import { z } from "zod";

const cache = new Map<string, { country: string | null; until: number }>();
const ipSchema = z.string().ip();

/** Best-effort country for a verified exit IP. No proxy credentials are sent. */
export async function lookupIpCountry(ip: string): Promise<string | null> {
  if (!ipSchema.safeParse(ip).success) return null;
  const cached = cache.get(ip);
  if (cached && cached.until > Date.now()) return cached.country;
  let country: string | null = null;
  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=ip,success,country_code`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(2500),
      headers: { accept: "application/json" },
    });
    if (response.ok && Number(response.headers.get("content-length") ?? 0) < 16_384) {
      const body = await response.text();
      if (body.length < 16_384) {
        const data: unknown = JSON.parse(body);
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const result = data as Record<string, unknown>;
          if (result["success"] === true && typeof result["country_code"] === "string" && /^[A-Z]{2}$/i.test(result["country_code"])) {
            country = result["country_code"].toUpperCase();
          }
        }
      }
    }
  } catch { /* Location is optional; never block proxy management on the geo service. */ }
  if (cache.size > 2048) cache.clear();
  cache.set(ip, { country, until: Date.now() + (country ? 6 * 60 * 60_000 : 5 * 60_000) });
  return country;
}
