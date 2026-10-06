import { connectionUnavailable, isConnectionUnavailable, setConnectionUnavailable } from "./panel-connectivity";

/** Coalesce wake/online/timer events; never replay a mutation or accept cached auth. */
export function createPanelRecovery({ verify, recovered, expired, paused = () => false }: {
  verify: () => Promise<unknown>;
  recovered: () => Promise<unknown>;
  expired: () => void;
  paused?: () => boolean;
}) {
  let pending: Promise<void> | undefined;
  let disposed = false;
  return {
    run() {
      if (disposed || paused()) return Promise.resolve();
      if (pending) return pending;
      pending = (async () => {
        try {
          const wasOffline = connectionUnavailable();
          const user = await verify();
          if (disposed || paused()) return;
          if (!user) { setConnectionUnavailable(false); expired(); return; }
          setConnectionUnavailable(false);
          if (wasOffline) await recovered();
        } catch (error) {
          if (isConnectionUnavailable(error) && !disposed) setConnectionUnavailable(true);
          // The next wake/online/timer retries auth only. No automatic sign-out,
          // native profile close or replay of a write operation on network loss.
        } finally { pending = undefined; }
      })();
      return pending;
    },
    dispose() { disposed = true; },
  };
}
