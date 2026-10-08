import { ConnectionUnavailableError, connectionUnavailable, isConnectionUnavailable, setConnectionUnavailable } from "./panel-connectivity";
import { SessionExpiredError } from "./auth-errors";

export type PanelRecoveryResult =
  | { status: "recovered" | "expired" | "skipped" }
  | { status: "offline" | "failed"; error: unknown };

// Router invalidation resolves even when a beforeLoad/loader failed. Only a
// successfully loaded route is proof that the panel has recovered.
export function assertPanelRoutesReady(matches: readonly { status: string; error?: unknown }[]) {
  const failed = matches.find((match) => match.status === "error");
  if (failed) throw failed.error ?? new Error("Не удалось загрузить панель. Повторите попытку.");
}

/** Coalesce wake/online/timer events; never replay a mutation or accept cached auth. */
export function createPanelRecovery({ verify, recovered, expired, paused = () => false, timeoutMs = 30_000, initialError }: {
  verify: (signal: AbortSignal) => Promise<unknown>;
  recovered: (signal: AbortSignal) => Promise<unknown>;
  expired: () => void;
  paused?: () => boolean;
  timeoutMs?: number;
  initialError?: unknown;
}) {
  let pending: Promise<PanelRecoveryResult> | undefined;
  let disposed = false;
  let active: AbortController | undefined;
  let applicationFailed = initialError !== undefined && !isConnectionUnavailable(initialError) && !(initialError instanceof SessionExpiredError);
  let expiryReported = false;
  const sessionExpired = (): PanelRecoveryResult => {
    applicationFailed = false;
    setConnectionUnavailable(false);
    if (!expiryReported) { expiryReported = true; expired(); }
    return { status: "expired" };
  };
  return {
    run({ retry = false }: { retry?: boolean } = {}): Promise<PanelRecoveryResult> {
      if (disposed || paused()) return Promise.resolve({ status: "skipped" });
      if (pending) return pending;
      if (applicationFailed && !retry) return Promise.resolve({ status: "skipped" });
      const controller = new AbortController();
      active = controller;
      const { signal } = controller;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => controller.abort(new ConnectionUnavailableError()), timeoutMs);
      });
      const operation = (async (): Promise<PanelRecoveryResult> => {
        const wasOffline = connectionUnavailable();
        const user = await verify(signal);
        if (signal.aborted || disposed || paused()) return { status: "skipped" };
        if (!user) return sessionExpired();
        expiryReported = false;
        // Resume/offline can arrive while a focus-triggered auth check is in
        // flight. Coalescing must still refetch the workspace in that case.
        // Explicit retry also refetches after a non-network failure, when the
        // global offline flag is correctly false.
        if (retry || wasOffline || connectionUnavailable()) await recovered(signal);
        if (signal.aborted || disposed || paused()) return { status: "skipped" };
        applicationFailed = false;
        setConnectionUnavailable(false);
        return { status: "recovered" };
      })();
      // Bound *both* auth and refetch. A hung recovered() must not permanently
      // hold the coalescing slot; late results cannot overwrite a newer attempt.
      pending = (async (): Promise<PanelRecoveryResult> => {
        try {
          return await Promise.race([operation, cancelled]);
        } catch (error) {
          if (disposed || paused()) return { status: "skipped" };
          if (error instanceof SessionExpiredError) return sessionExpired();
          const offline = isConnectionUnavailable(error);
          applicationFailed = !offline;
          setConnectionUnavailable(offline);
          // The next wake/online/timer retries auth only. No automatic sign-out,
          // native profile close or replay of a write operation on network loss.
          // Application errors stay visible until an explicit read-only retry.
          return { status: offline ? "offline" : "failed", error };
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          if (active === controller) { pending = undefined; active = undefined; }
        }
      })();
      return pending;
    },
    dispose() { disposed = true; active?.abort(new DOMException("Disposed", "AbortError")); },
  };
}
