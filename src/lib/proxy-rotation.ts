import type { ProxyCheckResult, ProxyRotationStatus } from "./proxy-input";

export const ROTATION_TIMEOUT_MS = 90_000;
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
  // require the same new address in two consecutive fresh connections.
  let candidateIp: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await wait(attempt === 0 ? 1500 : 3000);
    const result = await probe();
    const final = attempt === attempts - 1;
    const changedIp = result.ok && result.ip && result.ip !== previousIp ? result.ip : null;
    const confirmed = changedIp !== null && changedIp === candidateIp;
    if (confirmed) {
      const saved = await record(result, true, true);
      if (saved && typeof saved === "object" && "staleRotation" in saved && saved.staleRotation === true) {
        return { ...result, rotationConfirmed: false };
      }
      return { ...result, rotationConfirmed: true };
    }
    candidateIp = changedIp;
    const saved = await record(result, final, false);
    if (saved && typeof saved === "object" && "staleRotation" in saved && saved.staleRotation === true) {
      return { ...result, rotationConfirmed: false };
    }
  }
  throw new Error("Провайдер принял запрос, но новый IP не подтверждён. Повторите проверку позже.");
}
