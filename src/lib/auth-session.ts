import type { Session, User } from "@supabase/supabase-js";
import { recoverLegacyOwnerSession, supabase } from "./app-supabase";
import { ConnectionUnavailableError } from "./panel-connectivity";
import { SessionExpiredError } from "./auth-errors";

const REFRESH_MARGIN_SECONDS = 60;
export const AUTH_OPERATION_TIMEOUT_MS = 8_000;

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
  if (error.status === 401 || error.status === 403) return true;
  const value = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  return /invalid.*refresh|refresh.*not.*found|refresh.*already.*used|session.*not.*found|bad_jwt|jwt.*expired/.test(value);
}

export async function withAuthTimeout<T>(operation: PromiseLike<T>, timeoutMs = AUTH_OPERATION_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ConnectionUnavailableError("Сервер авторизации не ответил вовремя.")), timeoutMs);
  });
  try { return await Promise.race([Promise.resolve(operation), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

async function clearExpiredSession() {
  try { await withAuthTimeout(supabase.auth.signOut({ scope: "local" })); }
  catch { /* Локальная очистка выполняется по возможности; защищённые запросы уже остановлены. */ }
}

async function refreshStoredSession(): Promise<Session> {
  refreshJob ??= withAuthTimeout(supabase.auth.refreshSession());
  const currentJob = refreshJob;
  let result: RefreshResult;
  try { result = await currentJob; }
  finally { if (refreshJob === currentJob) refreshJob = undefined; }
  if (result.error) {
    if (isDefinitiveAuthFailure(result.error)) {
      await clearExpiredSession();
      throw new SessionExpiredError();
    }
    throw new ConnectionUnavailableError("Не удалось обновить сессию. Повторим подключение автоматически.");
  }
  if (!result.data.session) {
    await clearExpiredSession();
    throw new SessionExpiredError();
  }
  return result.data.session;
}

export async function forceRefreshSession(): Promise<Session> {
  return refreshStoredSession();
}

export async function expireLocalSession(): Promise<void> {
  await clearExpiredSession();
}

export async function getUsableSession(): Promise<Session | null> {
  await withAuthTimeout(recoverLegacyOwnerSession());
  const { data, error } = await withAuthTimeout(supabase.auth.getSession());
  if (error) {
    if (isDefinitiveAuthFailure(error)) {
      await clearExpiredSession();
      return null;
    }
    throw new ConnectionUnavailableError("Не удалось прочитать сессию. Повторим подключение автоматически.");
  }
  if (!data.session) return null;
  return sessionNeedsRefresh(data.session) ? refreshStoredSession() : data.session;
}

export async function getAuthenticatedUser(): Promise<User | null> {
  const session = await getUsableSession();
  if (!session) return null;
  const { data, error } = await withAuthTimeout(supabase.auth.getUser(session.access_token));
  // Auth success alone is not workspace recovery: RPC refetch can still fail.
  if (!error && data.user) return data.user;
  if (isDefinitiveAuthFailure(error)) {
    await clearExpiredSession();
    return null;
  }
  if (error) throw new ConnectionUnavailableError("Не удалось проверить сессию. Повторим подключение автоматически.");
  await clearExpiredSession();
  return null;
}
