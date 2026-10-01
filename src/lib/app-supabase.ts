import { createClient } from "@supabase/supabase-js";
import { supabase as primaryClient } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { clearEmployeePreview, employeeAuthKey, EMPLOYEE_EXIT_KEY, LEGACY_PREVIEW_KEY, readEmployeePreview, saveEmployeePreview, type EmployeePreview } from "./employee-session-storage";

// The primary client owns the persistent login. An authorized employee preview
// gets a separate auth client/storage, never setSession on the primary client.
// sessionStorage survives navigation/reload, but a new application window has
// no overlay and therefore starts with the original persistent identity.
type Client = typeof primaryClient;
let activeClient: Client | undefined;
let legacyRecovery: Promise<void> | undefined;
let primarySignInPending = false;

export function isPrimarySignInPending() { return primarySignInPending; }

// Explicit credentials always replace the persistent identity, never a preview.
// AuthSync must not redirect halfway through verification/overlay cleanup.
export async function signInPrimaryAccount(email: string, password: string) {
  if (primarySignInPending) throw new Error("Вход уже выполняется");
  primarySignInPending = true;
  try {
    // Finish any legacy restoration already started before this explicit login.
    // Otherwise its late response could overwrite the newly entered account.
    if (legacyRecovery) await legacyRecovery.catch(() => {});
    const result = await primaryClient.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    if (!result.data.session || !result.data.user) throw new Error("Не удалось подтвердить вход");
    const verified = await primaryClient.auth.getUser(result.data.session.access_token);
    if (verified.error || verified.data.user?.id !== result.data.user.id
      || verified.data.user.email?.toLowerCase() !== email.toLowerCase()) {
      await primaryClient.auth.signOut({ scope: "local" });
      throw new Error("Сервер вернул другую учётную запись. Повторите вход.");
    }
    await leaveEmployeePreview();
    sessionStorage.removeItem(LEGACY_PREVIEW_KEY);
    sessionStorage.removeItem(EMPLOYEE_EXIT_KEY);
    return verified.data.user;
  } finally { primarySignInPending = false; }
}

function temporaryClient(preview: EmployeePreview): Client {
  const url = import.meta.env["VITE_SUPABASE_URL"] || process.env["SUPABASE_URL"];
  const key = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] || process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) throw new Error("Сервис авторизации не настроен");
  return createClient<Database>(url, key, {
    global: { fetch: (input, init) => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      if ((key.startsWith("sb_publishable_") || key.startsWith("sb_secret_")) && headers.get("Authorization") === `Bearer ${key}`) headers.delete("Authorization");
      headers.set("apikey", key);
      return fetch(input, { ...init, headers });
    } },
    auth: { storageKey: employeeAuthKey(preview), storage: sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
}

function client(): Client {
  // Pin the client for this document. Losing/expiring employee credentials
  // must not silently promote an in-flight employee request to owner rights.
  if (!activeClient) {
    const preview = employeePreview();
    activeClient = preview ? temporaryClient(preview) : primaryClient;
  }
  return activeClient;
}

export const supabase = new Proxy({} as Client, {
  get(_target, prop) {
    const selected = client();
    const value = Reflect.get(selected, prop, selected);
    return typeof value === "function" ? value.bind(selected) : value;
  },
});

export function employeePreview(): EmployeePreview | null {
  return typeof window === "undefined" ? null : readEmployeePreview(sessionStorage);
}

export async function beginEmployeePreview(preview: EmployeePreview, tokens: { access_token: string; refresh_token: string }) {
  if (employeePreview()) throw new Error("Сначала вернитесь в свой аккаунт");
  const original = await primaryClient.auth.getSession();
  if (original.error || original.data.session?.user.id !== preview.ownerId) throw new Error("Сессия владельца недоступна. Войдите заново.");
  const temporary = temporaryClient(preview);
  try {
    const result = await temporary.auth.setSession(tokens);
    if (result.error || result.data.user?.id !== preview.employeeId) throw new Error("Не удалось переключиться на сотрудника");
    saveEmployeePreview(sessionStorage, preview);
  } catch (error) {
    clearEmployeePreview(sessionStorage, preview);
    throw error;
  } finally {
    await temporary.auth.stopAutoRefresh();
  }
}

export async function leaveEmployeePreview() {
  if (!employeePreview()) return;
  await client().auth.stopAutoRefresh();
  await client().realtime.disconnect();
  clearEmployeePreview(sessionStorage);
  // Caller reloads the document; existing requests remain employee-bound.
}

export async function recoverLegacyOwnerSession() {
  if (typeof window === "undefined" || employeePreview()) return;
  legacyRecovery ??= (async () => {
    const raw = sessionStorage.getItem(LEGACY_PREVIEW_KEY);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw);
      if (typeof saved.ownerAccessToken !== "string" || typeof saved.ownerRefreshToken !== "string" || typeof saved.ownerId !== "string") throw new Error();
      const result = await primaryClient.auth.setSession({ access_token: saved.ownerAccessToken, refresh_token: saved.ownerRefreshToken });
      if (result.error || result.data.user?.id !== saved.ownerId) throw new Error();
    } catch {
      // An expired legacy escrow must lead to login, not a persisted employee
      // identity that the operator cannot leave.
      await primaryClient.auth.signOut({ scope: "local" });
    } finally { sessionStorage.removeItem(LEGACY_PREVIEW_KEY); }
  })();
  await legacyRecovery;
}
