const PROJECT_REF = "mqyjnsbhsfgorjzycwpd";
export const PROJECT_ORIGIN = `https://${PROJECT_REF}.supabase.co`;
export const RPC_URL = `${PROJECT_ORIGIN}/rest/v1/rpc/umbra_availability`;
export const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 128;
const FAILURE_MESSAGE = "Supabase availability check failed";

class ProbeFailure extends Error {
  constructor(stage, status = 0, retryable = false) {
    super(FAILURE_MESSAGE);
    this.stage = stage;
    this.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
    this.retryable = retryable;
  }
}

function publicKey(environment) {
  const key = environment?.SUPABASE_PUBLISHABLE_KEY;
  if (environment?.SUPABASE_URL !== PROJECT_ORIGIN || typeof key !== "string" || key.length > 4096) {
    throw new ProbeFailure("configuration");
  }
  if (/^sb_publishable_[A-Za-z0-9_-]{20,160}$/.test(key)) return key;
  const parts = key.split(".");
  if (parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) {
    try {
      const decode = part => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
      const header = decode(parts[0]);
      const payload = decode(parts[1]);
      // This checks credential type/project only; Supabase verifies the signature.
      if (header.alg === "HS256" && header.typ === "JWT" && payload.role === "anon" && payload.ref === PROJECT_REF) return key;
    } catch { /* Invalid public credential; never include its contents in errors. */ }
  }
  throw new ProbeFailure("configuration");
}

async function probe(key, { fetcher, setTimer, clearTimer }) {
  const controller = new AbortController();
  let reader;
  let timer;
  const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
  const deadline = new Promise((_, reject) => {
    timer = setTimer(() => {
      controller.abort();
      cancel();
      reject(new ProbeFailure("timeout", 0, true));
    }, TIMEOUT_MS);
  });
  try {
    const operation = (async () => {
      const response = await fetcher(RPC_URL, {
        method: "POST",
        headers: { apikey: key, "content-type": "application/json", accept: "application/json" },
        body: "{}",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status !== 200) {
        if (response.body) void response.body.cancel().catch(() => {});
        throw new ProbeFailure("http", response.status, response.status === 429 || response.status >= 500);
      }
      if (response.redirected || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" || !response.body) {
        if (response.body) void response.body.cancel().catch(() => {});
        throw new ProbeFailure("response", response.status);
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      let body = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BODY_BYTES) throw new ProbeFailure("response", response.status);
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      try { if (JSON.parse(body) === true) return response.status; }
      catch { /* A malformed response is a failure; never log its body. */ }
      throw new ProbeFailure("response", response.status);
    })();
    return await Promise.race([operation, deadline]);
  } catch (error) {
    cancel();
    throw error instanceof ProbeFailure ? error : new ProbeFailure("network", 0, true);
  } finally {
    clearTimer(timer);
  }
}

export async function checkAvailability(environment, {
  fetcher = fetch, logger = event => console.log(JSON.stringify(event)),
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let key;
  try { key = publicKey(environment); }
  catch {
    logger({ stage: "configuration", status: 0, durationMs: 0, attempt: 0 });
    throw new Error(FAILURE_MESSAGE);
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = now();
    let failure;
    let status = 0;
    try { status = await probe(key, { fetcher, setTimer, clearTimer }); }
    catch (error) { failure = error; }
    const elapsed = now() - started;
    logger({
      stage: failure?.stage ?? "healthy", status: failure?.status ?? status,
      durationMs: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0, attempt,
    });
    if (!failure) return;
    if (!failure.retryable || attempt === 2) throw new Error(FAILURE_MESSAGE);
  }
}

export default {
  async scheduled(_event, environment) { await checkAvailability(environment); },
};
