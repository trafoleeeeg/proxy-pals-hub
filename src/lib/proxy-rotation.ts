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
  previousIp, probe, record, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 40,
}: {
  previousIp: string;
  probe: () => Promise<ProxyCheckResult>;
  record: (result: ProxyCheckResult, final: boolean, confirmed: boolean) => Promise<unknown>;
  wait?: (ms: number) => Promise<unknown>;
  attempts?: number;
}) {
  // Для мобильного прокси первый успешный ответ с адресом, отличным от
  // исходного, уже подтверждает смену. Дополнительная проверка удерживала
  // интерфейс в состоянии «меняем IP» до общего тайм-аута провайдера.
  for (let attempt = 0; attempt < attempts; attempt++) {
    await wait(attempt === 0 ? 300 : 900);
    // A mobile modem may briefly drop the connection while switching IPs.
    // Keep polling instead of treating one failed desktop probe as the result.
    const result = await probe().catch(() => ({ ok: false as const }));
    const final = attempt === attempts - 1;
    const changedIp = result.ok && result.ip && result.ip !== previousIp ? result.ip : null;
    if (changedIp !== null) {
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
