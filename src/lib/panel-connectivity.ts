export class ConnectionUnavailableError extends Error {
  constructor(message = "Нет связи с сервером. Повторим подключение автоматически.") {
    super(message);
    this.name = "ConnectionUnavailableError";
    setConnectionUnavailable(true);
  }
}

let unavailable = false;
const listeners = new Set<() => void>();
export const connectionUnavailable = () => unavailable;
export function subscribeConnection(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setConnectionUnavailable(value: boolean) {
  if (unavailable === value) return;
  unavailable = value;
  listeners.forEach((listener) => listener());
}
export function isConnectionUnavailable(error: unknown): boolean {
  return error instanceof ConnectionUnavailableError;
}

/** Retain only an already verified UI identity; server requests still require fresh auth. */
export async function recoverVerifiedUser<T>(verify: () => Promise<T>, cached: T | undefined): Promise<T> {
  try { return await verify(); }
  catch (error) {
    if (cached !== undefined && isConnectionUnavailable(error)) return cached;
    throw error;
  }
}

/** Abort the actual request, not only the caller's wait. Never log URLs or credentials. */
export async function boundedFetch(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 6_000, fetcher: typeof fetch = fetch): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("Request timed out", "TimeoutError");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([fetcher(input, { ...init, signal }), deadline]); }
  finally { if (timer) clearTimeout(timer); }
}
