import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./client";

const REFRESH_MARGIN_SECONDS = 60;
type AuthFailure = {
  code?: string | undefined;
  message?: string | undefined;
  status?: number | undefined;
} | null | undefined;
type RefreshResult = Awaited<ReturnType<typeof supabase.auth.refreshSession>>;
let refreshJob: Promise<RefreshResult> | undefined;

export function sessionNeedsRefresh(session: Pick<Session, "expires_at">, now = Date.now()): boolean {
  return !session.expires_at || session.expires_at * 1_000 <= now + REFRESH_MARGIN_SECONDS * 1_000;
}

export function isDefinitiveAuthFailure(error: AuthFailure): boolean {
  if (!error) return false;
  if (error.status != null && error.status >= 400 && error.status < 500) return true;
  const value = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  return /invalid.*refresh|refresh.*not.*found|refresh.*already.*used|session.*not.*found|bad_jwt|jwt.*expired/.test(value);
}

async function clearExpiredSession() {
  try { await supabase.auth.signOut({ scope: "local" }); }
  catch { /* Storage cleanup is best effort; the redirect still blocks stale requests. */ }
}

async function refreshStoredSession(): Promise<Session> {
  refreshJob ??= supabase.auth.refreshSession();
  let result: RefreshResult;
  try { result = await refreshJob; }
  finally { refreshJob = undefined; }
  if (result.error) {
    if (isDefinitiveAuthFailure(result.error)) {
      await clearExpiredSession();
      throw new Error("Сессия истекла. Войдите снова.");
    }
    throw new Error("Не удалось обновить сессию. Проверьте подключение.");
  }
  if (!result.data.session) {
    await clearExpiredSession();
    throw new Error("Сессия истекла. Войдите снова.");
  }
  return result.data.session;
}

export async function getUsableSession(): Promise<Session | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    if (isDefinitiveAuthFailure(error)) {
      await clearExpiredSession();
      return null;
    }
    throw new Error("Не удалось прочитать сессию. Проверьте подключение.");
  }
  if (!data.session) return null;
  return sessionNeedsRefresh(data.session) ? refreshStoredSession() : data.session;
}

export async function getAuthenticatedUser(): Promise<User | null> {
  const session = await getUsableSession();
  if (!session) return null;
  const { data, error } = await supabase.auth.getUser(session.access_token);
  if (!error && data.user) return data.user;
  if (isDefinitiveAuthFailure(error)) {
    await clearExpiredSession();
    return null;
  }
  if (error) throw new Error("Не удалось проверить сессию. Проверьте подключение.");
  if (!data.user) {
    await clearExpiredSession();
    return null;
  }
  return data.user;
}
