import { test, expect } from "bun:test";
import { notifyPanelPainted } from "../src/lib/panel-paint";

function frames() {
  const pending = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  return {
    request: (callback: FrameRequestCallback) => { pending.set(++sequence, callback); return sequence; },
    cancel: (id: number) => { pending.delete(id); },
    paint: () => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(cb => cb(0)); },
  };
}

test("desktop reveal waits for a committed paint, without another web splash", async () => {
  const frame = frames();
  let calls = 0;
  notifyPanelPainted({ panelReady: async () => { calls++; return { ok: true }; } }, frame.request, frame.cancel);
  expect(calls).toBe(0);
  frame.paint(); expect(calls).toBe(0);
  frame.paint(); expect(calls).toBe(1);
});

test("unmount and route changes cancel either pending frame", () => {
  for (const afterFirst of [false, true]) {
    const frame = frames();
    let calls = 0;
    const cleanup = notifyPanelPainted({ panelReady: async () => { calls++; return { ok: true }; } }, frame.request, frame.cancel);
    if (afterFirst) frame.paint();
    cleanup(); frame.paint(); frame.paint();
    expect(calls).toBe(0);
  }
});

test("ordinary browsers and older desktop bridges do not require ready IPC", () => {
  const frame = frames();
  const request = () => { throw new Error("must not schedule"); };
  notifyPanelPainted(undefined, request, frame.cancel)();
  notifyPanelPainted({}, request, frame.cancel)();
});

test("a rejected ready IPC does not crash the web panel", async () => {
  const frame = frames();
  notifyPanelPainted({ panelReady: async () => { throw new Error("window closed"); } }, frame.request, frame.cancel);
  frame.paint(); frame.paint();
  await Promise.resolve();
});
