import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { isPrimarySignInPending } from "@/lib/app-supabase";
import { connectionUnavailable, isConnectionUnavailable, setConnectionUnavailable, subscribeConnection } from "@/lib/panel-connectivity";
import { createPanelRecovery } from "@/lib/panel-recovery";
import { createPanelWake } from "@/lib/panel-wake";
import { SessionExpiredError } from "@/lib/auth-errors";
import { desktop } from "@/lib/desktop";

export function PanelConnection({ recovered, fullPage = false, initialError }: { recovered: (signal: AbortSignal) => Promise<unknown>; fullPage?: boolean; initialError?: unknown }) {
  const offline = useSyncExternalStore(subscribeConnection, connectionUnavailable, () => false);
  const callback = useRef(recovered);
  callback.current = recovered;
  const runRecovery = useRef<(retry?: boolean) => Promise<void>>(async () => {});
  const [busy, setBusy] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(initialError instanceof SessionExpiredError);
  const [failed, setFailed] = useState(initialError !== undefined && !isConnectionUnavailable(initialError) && !(initialError instanceof SessionExpiredError));
  const [showOffline, setShowOffline] = useState(false);
  useEffect(() => {
    if (!offline) { setShowOffline(false); return; }
    // A short wake reconnect is not an error screen. A persistent real outage
    // still gets a single visible status; no auth or data checks are bypassed.
    const timer = window.setTimeout(() => setShowOffline(true), 3_000);
    return () => window.clearTimeout(timer);
  }, [offline]);
  useEffect(() => {
    const task = createPanelRecovery({
      verify: getAuthenticatedUser,
      recovered: (signal) => callback.current(signal),
      paused: isPrimarySignInPending,
      expired: () => { if (location.pathname !== "/auth") location.replace("/auth?next=%2Fapp"); },
      initialError,
    });
    let disposed = false;
    const run = async (options: { retry?: boolean; refresh?: boolean } = {}) => {
      const result = await task.run(options);
      if (!disposed && result.status !== "skipped") {
        setFailed(result.status === "failed");
        setSessionExpired(result.status === "expired");
      }
      return result;
    };
    const coordinator = createPanelWake({ run, needsRecovery: task.needsRecovery, visible: () => document.visibilityState !== "hidden" });
    runRecovery.current = async () => { await coordinator.retry(); };
    const wake = () => coordinator.wake();
    const lost = () => setConnectionUnavailable(true);
    const resume = () => coordinator.wake(true);
    const offConnection = subscribeConnection(() => queueMicrotask(() => coordinator.connectionChanged()));
    const offResume = desktop()?.onPanelResume?.(resume);
    window.addEventListener("online", wake);
    window.addEventListener("offline", lost);
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    document.addEventListener("visibilitychange", wake);
    const timer = window.setInterval(() => coordinator.tick(), 15_000);
    if (task.needsRecovery()) coordinator.wake(true);
    return () => {
      disposed = true;
      task.dispose();
      coordinator.dispose();
      offConnection();
      offResume?.();
      runRecovery.current = async () => {};
      window.clearInterval(timer);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", lost);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  async function retry() {
    setBusy(true);
    try { await runRecovery.current(true); }
    finally { setBusy(false); }
  }
  if (!showOffline && !fullPage && !failed && !sessionExpired) return null;
  return <div role="status" aria-live="polite" className={fullPage ? "space-y-4" : "fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg"}>
    <div>
      <p className="font-medium">{sessionExpired ? "Сессия истекла" : failed ? "Не удалось восстановить панель" : "Нет связи с сервером"}</p>
      <p className="text-sm text-muted-foreground">{sessionExpired ? "Переходим на страницу входа." : failed ? "Не удалось загрузить данные панели. Повторите попытку или перезагрузите панель." : "Повторяем подключение автоматически. Сетевые действия временно недоступны."}</p>
    </div>
    <button disabled={busy} onClick={() => void retry()} className="shrink-0 rounded-md border border-input px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">{busy ? "Проверяем…" : "Повторить"}</button>
  </div>;
}
