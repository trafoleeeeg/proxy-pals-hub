import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { brokeredPreviewStorage } from "@/integrations/supabase/previewAuthStorage";
import { boundedFetch, setConnectionUnavailable } from "./panel-connectivity";

export function sessionFetch(key: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    if ((key.startsWith("sb_publishable_") || key.startsWith("sb_secret_")) && headers.get("Authorization") === `Bearer ${key}`) headers.delete("Authorization");
    headers.set("apikey", key);
    const url = input instanceof Request ? input.url : String(input);
    // Bound background auth too: a hung refresh otherwise holds the SDK lock
    // and subsequent getSession/refresh calls cannot recover after network return.
    return /\/auth\/v1\//.test(url) ? boundedFetch(input, { ...init, headers }, 6_000, fetch, true).catch((error) => {
      setConnectionUnavailable(true);
      throw error;
    }) : fetch(input, { ...init, headers });
  };
}

let instance: SupabaseClient<Database> | undefined;
export const primaryClient = new Proxy({} as SupabaseClient<Database>, {
  get(_target, prop) {
    if (!instance) {
      const url = import.meta.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"];
      const key = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] || process.env["SUPABASE_PUBLISHABLE_KEY"];
      if (!url || !key) throw new Error("Сервис авторизации не настроен");
      // Same default storage key and preview broker as before; no migration,
      // session copying or replacement of the user's persistent credentials.
      instance = createClient<Database>(url, key, {
        global: { fetch: sessionFetch(key) },
        auth: { storage: brokeredPreviewStorage(), persistSession: true, autoRefreshToken: true },
      });
    }
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
