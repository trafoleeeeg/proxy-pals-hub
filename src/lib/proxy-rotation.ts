import type { ProxyCheckResult, ProxyRotationStatus } from "./proxy-input";

export const ROTATION_TIMEOUT_MS = 60_000;
/** PostgREST may return the same timestamptz with +00:00 and extra fractional digits. */
export function sameRotationRequest(requestedAt: string | null | undefined, storedAt: string | null | undefined) {
  const requested = Date.parse(requestedAt ?? "");
  const stored = Date.parse(storedAt ?? "");
  return Number.isFinite(requested) && Number.isFinite(stored) && requested === stored;
}

export function rotationExpired(requestedAt: string | null | undefined, now = Date.now()) {
  const time = Date.parse(requestedAt ?? "");
  return !Number.isFinite(time) || now - time >= ROTATION_TIMEOUT_MS;
}

/** With no baseline, success means restored connectivity, not a proven IP change. */
export function rotationOutcome(previousIp: string | null, result: ProxyCheckResult, final: boolean, confirmed = true): ProxyRotationStatus {
  if (confirmed && result.ok && result.ip && (previousIp ? result.ip !== previousIp : final)) return "success";
  return final ? "error" : "changing";
}

/** Rotation is a recovery action: an unavailable tunnel must not block its provider URL. */
export async function prepareRotation<T>({ probe, record, request }: {
  probe: () => Promise<ProxyCheckResult>;
  record: (result: ProxyCheckResult) => Promise<unknown>;
  request: () => Promise<T>;
}) {
  const before = await probe().catch(() => ({ ok: false as const }));
  await record(before);
  return request();
}

export async function confirmRotation({
  previousIp, probe, record, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 40,
}: {
  previousIp: string | null;
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
        return { ...result, rotationConfirmed: false, connectionRestored: false };
      }
      return { ...result, rotationConfirmed: previousIp !== null, connectionRestored: previousIp === null };
    }
    const saved = await record(result, final, false);
    if (saved && typeof saved === "object" && "staleRotation" in saved && saved.staleRotation === true) {
      return { ...result, rotationConfirmed: false, connectionRestored: false };
    }
  }
  throw new Error(previousIp
    ? "Запрос смены отправлен, но новый IP не подтверждён. Повторите проверку позже."
    : "Запрос смены отправлен, но подключение к прокси пока не восстановилось. Повторите проверку позже.");
}
