import { ConnectionUnavailableError, connectionUnavailable, isConnectionUnavailable, setConnectionUnavailable } from "./panel-connectivity";

/** Coalesce wake/online/timer events; never replay a mutation or accept cached auth. */
export function createPanelRecovery({ verify, recovered, expired, paused = () => false, timeoutMs = 30_000 }: {
  verify: (signal: AbortSignal) => Promise<unknown>;
  recovered: (signal: AbortSignal) => Promise<unknown>;
  expired: () => void;
  paused?: () => boolean;
  timeoutMs?: number;
}) {
  let pending: Promise<void> | undefined;
  let disposed = false;
  let active: AbortController | undefined;
  return {
    run() {
      if (disposed || paused()) return Promise.resolve();
      if (pending) return pending;
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
      const operation = (async () => {
        const wasOffline = connectionUnavailable();
        const user = await verify(signal);
        if (signal.aborted || disposed || paused()) return;
        if (!user) { setConnectionUnavailable(false); expired(); return; }
        // Resume/offline can arrive while a focus-triggered auth check is in
        // flight. Coalescing must still refetch the workspace in that case.
        if (wasOffline || connectionUnavailable()) await recovered(signal);
        if (!signal.aborted && !disposed && !paused()) setConnectionUnavailable(false);
      })();
      // Bound *both* auth and refetch. A hung recovered() must not permanently
      // hold the coalescing slot; late results cannot overwrite a newer attempt.
      pending = (async () => {
        try {
          await Promise.race([operation, cancelled]);
        } catch (error) {
          if (isConnectionUnavailable(error) && !disposed) setConnectionUnavailable(true);
          // The next wake/online/timer retries auth only. No automatic sign-out,
          // native profile close or replay of a write operation on network loss.
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
