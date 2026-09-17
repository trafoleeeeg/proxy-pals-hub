import type { ProxyCheckResult, ProxyRotationStatus } from "./proxy-input";

export const ROTATION_TIMEOUT_MS = 90_000;
export function rotationExpired(requestedAt: string | null | undefined, now = Date.now()) {
  const time = Date.parse(requestedAt ?? "");
  return !Number.isFinite(time) || now - time >= ROTATION_TIMEOUT_MS;
}

/** A reachable proxy is not proof of rotation: the actual address must differ. */
export function rotationOutcome(previousIp: string | null, result: ProxyCheckResult, final: boolean): ProxyRotationStatus {
  if (result.ok && previousIp && result.ip && result.ip !== previousIp) return "success";
  return final ? "error" : "changing";
}

export async function confirmRotation({
  previousIp, probe, record, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 12,
}: {
  previousIp: string;
  probe: () => Promise<ProxyCheckResult>;
  record: (result: ProxyCheckResult, final: boolean) => Promise<unknown>;
  wait?: (ms: number) => Promise<unknown>;
  attempts?: number;
}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await wait(attempt === 0 ? 2000 : 4000);
    const result = await probe();
    const final = attempt === attempts - 1;
    await record(result, final);
    if (rotationOutcome(previousIp, result, final) === "success") return result;
  }
  throw new Error("Провайдер принял запрос, но новый IP не подтверждён. Повторите проверку позже.");
}
