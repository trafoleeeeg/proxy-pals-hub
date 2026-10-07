import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { isPrimarySignInPending } from "@/lib/app-supabase";
import { connectionUnavailable, setConnectionUnavailable, subscribeConnection } from "@/lib/panel-connectivity";
import { createPanelRecovery } from "@/lib/panel-recovery";
import { desktop } from "@/lib/desktop";

export function PanelConnection({ recovered, fullPage = false }: { recovered: (signal: AbortSignal) => Promise<unknown>; fullPage?: boolean }) {
  const offline = useSyncExternalStore(subscribeConnection, connectionUnavailable, () => false);
  const callback = useRef(recovered);
  callback.current = recovered;
  const recovery = useRef<ReturnType<typeof createPanelRecovery> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const task = createPanelRecovery({
      verify: getAuthenticatedUser,
      recovered: (signal) => callback.current(signal),
      paused: isPrimarySignInPending,
      expired: () => { if (location.pathname !== "/auth") location.replace("/auth?next=%2Fapp"); },
    });
    recovery.current = task;
    let lastWake = 0;
    const wake = () => {
      if (document.visibilityState === "hidden" || Date.now() - lastWake < 2_000) return;
      lastWake = Date.now();
      void task.run();
    };
    const lost = () => setConnectionUnavailable(true);
    const resume = () => { lost(); wake(); };
    const offResume = desktop()?.onPanelResume?.(resume);
    window.addEventListener("online", wake);
    window.addEventListener("offline", lost);
    window.addEventListener("focus", wake);
    window.addEventListener("pageshow", wake);
    document.addEventListener("visibilitychange", wake);
    let lastTick = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      // Also works in the web panel / older desktops without the native wake
      // event, including sleep without a navigator.onLine transition.
      if (now - lastTick > 45_000) lost();
      lastTick = now;
      if (connectionUnavailable()) wake();
    }, 15_000);
    if (offline) wake();
    return () => {
      task.dispose();
      offResume?.();
      recovery.current = null;
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
    try { await recovery.current?.run(); }
    finally { setBusy(false); }
  }
  if (!offline && !fullPage) return null;
  return <div role="status" aria-live="polite" className={fullPage ? "space-y-4" : "fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg"}>
    <div>
      <p className="font-medium">Нет связи с сервером</p>
      <p className="text-sm text-muted-foreground">Повторяем подключение автоматически. Сетевые действия временно недоступны.</p>
    </div>
    <button disabled={busy} onClick={() => void retry()} className="shrink-0 rounded-md border border-input px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">{busy ? "Подключение…" : "Повторить"}</button>
  </div>;
}
