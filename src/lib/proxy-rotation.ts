import type { ProxyCheckResult, ProxyRotationStatus } from "./proxy-input";

export const ROTATION_TIMEOUT_MS = 60_000;
export function rotationExpired(requestedAt: string | null | undefined, now = Date.now()) {
  const time = Date.parse(requestedAt ?? "");
  return !Number.isFinite(time) || now - time >= ROTATION_TIMEOUT_MS;
}

/** A reachable proxy is not proof of rotation: the actual address must differ. */
export function rotationOutcome(previousIp: string | null, result: ProxyCheckResult, final: boolean, confirmed = true): ProxyRotationStatus {
  if (confirmed && result.ok && previousIp && result.ip && result.ip !== previousIp) return "success";
  return final ? "error" : "changing";
}

export async function confirmRotation({
  previousIp, probe, record, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 16,
}: {
  previousIp: string;
  probe: () => Promise<ProxyCheckResult>;
  record: (result: ProxyCheckResult, final: boolean, confirmed: boolean) => Promise<unknown>;
  wait?: (ms: number) => Promise<unknown>;
  attempts?: number;
}) {
  // Mobile providers can expose one or more short-lived exit addresses while
  // the modem reconnects. Do not publish the first different IP as final:
  // require the same new address in two fresh connections. Mobile exits flap
  // during reconnect, so the two sightings do not have to be consecutive —
  // otherwise every flap resets the counter and the wait burns the whole
  // rotation timeout even though the IP changed long ago.
  // Проверяем часто, чтобы подтверждение нового IP занимало секунды, а не минуту.
  const sightings = new Map<string, number>();
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Короткие паузы: подтверждение занимает секунды, а не минуту.
    await wait(attempt === 0 ? 300 : 600);
    const result = await probe();
    const final = attempt === attempts - 1;
    const changedIp = result.ok && result.ip && result.ip !== previousIp ? result.ip : null;
    const seen = changedIp !== null ? (sightings.get(changedIp) ?? 0) + 1 : 0;
    if (changedIp !== null) sightings.set(changedIp, seen);
    if (seen >= 2) {
      const saved = await record(result, true, true);
      if (saved && typeof saved === "object" && "staleRotation" in saved && saved.staleRotation === true) {
        return { ...result, rotationConfirmed: false };
      }
      return { ...result, rotationConfirmed: true };
    }
    const saved = await record(result, final, false);
    if (saved && typeof saved === "object" && "staleRotation" in saved && saved.staleRotation === true) {
      return { ...result, rotationConfirmed: false };
    }
  }
  throw new Error("Провайдер принял запрос, но новый IP не подтверждён. Повторите проверку позже.");
}
