import type { PanelRecoveryResult } from "./panel-recovery";

const RETRY_DELAYS = [250, 750, 1_500, 3_000, 5_000, 15_000];

/** One read-only wake path. Sleep is not proof of network loss. */
export function createPanelWake({ run, needsRecovery, visible, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout }: {
  run: (options: { retry?: boolean; refresh?: boolean }) => Promise<PanelRecoveryResult>;
  needsRecovery: () => boolean;
  visible: () => boolean;
  now?: () => number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}) {
  let disposed = false;
  let pending: Promise<PanelRecoveryResult> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryIndex = 0;
  let lastWake = -Infinity;
  let lastTick = now();
  const clearRetry = () => { if (retryTimer !== undefined) cancel(retryTimer); retryTimer = undefined; };
  function start(options: { retry?: boolean; refresh?: boolean } = {}) {
    if (disposed || !visible()) return Promise.resolve<PanelRecoveryResult>({ status: "skipped" });
    if (pending) return pending;
    clearRetry();
    pending = run(options).then(result => {
      if (disposed) return result;
      if (result.status === "offline" && visible()) {
        const delay = RETRY_DELAYS[Math.min(retryIndex++, RETRY_DELAYS.length - 1)]!;
        retryTimer = schedule(() => { retryTimer = undefined; void start({ refresh: true }); }, delay);
      } else if (result.status === "recovered") retryIndex = 0;
      return result;
    }).finally(() => { pending = undefined; });
    return pending;
  }
  return {
    wake(urgent = false) {
      if (!visible()) { clearRetry(); return; }
      if (!urgent && now() - lastWake < 2_000) return;
      lastWake = now();
      void start({ refresh: true });
    },
    connectionChanged() { if (needsRecovery()) void start({ refresh: true }); },
    tick() {
      const current = now();
      const slept = current - lastTick > 45_000;
      lastTick = current;
      if (slept) this.wake(true);
      else if (needsRecovery() && retryTimer === undefined) void start({ refresh: true });
    },
    retry: () => start({ retry: true, refresh: true }),
    dispose() { disposed = true; clearRetry(); },
  };
}
