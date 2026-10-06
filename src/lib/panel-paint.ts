import type { UmbraBridge } from "./desktop";

/** Signal only after React's committed route has had a frame to paint. */
export function notifyPanelPainted(
  bridge: Pick<UmbraBridge, "panelReady"> | undefined,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (id: number) => void = cancelAnimationFrame,
) {
  if (!bridge?.panelReady) return () => {};
  let cancelled = false;
  let frame = requestFrame(() => {
    frame = requestFrame(() => {
      if (!cancelled) void bridge.panelReady?.().catch(() => {});
    });
  });
  return () => { cancelled = true; cancelFrame(frame); };
}
