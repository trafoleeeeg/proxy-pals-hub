import { createHash, randomBytes, timingSafeEqual } from "crypto";

/** Права, которые можно выдать агенту. Управление командой намеренно не выдаётся. */
export const AGENT_SCOPES = [
  "profiles:read",
  "profiles:write",
  "proxies:read",
  "proxies:write",
  "team:read",
] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number];

export type AgentContext = {
  keyId: string;
  teamId: string;
  name: string;
  scopes: AgentScope[];
};

const PREFIX = "umbra_live_";

/** Новый ключ: показывается владельцу один раз, в базе живёт только хеш. */
export function generateAgentKey(): { key: string; hash: string; prefix: string } {
  const key = PREFIX + randomBytes(32).toString("hex");
  return { key, hash: hashAgentKey(key), prefix: key.slice(0, PREFIX.length + 6) };
}

export function hashAgentKey(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class AgentError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** JSON responses from the token-authenticated API must never be cached. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function jsonError(err: unknown): Response {
  if (err instanceof AgentError) {
    return jsonResponse({ error: err.message }, { status: err.status });
  }
  console.error("agent api error", err);
  return jsonResponse({ error: "Внутренняя ошибка" }, { status: 500 });
}

/**
 * Проверяет ключ агента из заголовка Authorization: Bearer umbra_live_...
 * Возвращает команду и права. Бросает AgentError при любой проблеме.
 */
export async function authenticateAgent(request: Request): Promise<AgentContext> {
  const header = request.headers.get("authorization") ?? "";
  const raw = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!raw || !raw.startsWith(PREFIX)) throw new AgentError(401, "Нужен ключ агента");

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const hash = hashAgentKey(raw);
  const { data: row, error } = await supabaseAdmin
    .from("agent_keys")
    .select("id, team_id, name, scopes, key_hash, expires_at, revoked_at")
    .eq("key_hash", hash)
    .maybeSingle();

  if (error) throw new AgentError(500, "Не удалось проверить ключ");
  if (!row || !safeEqual(row.key_hash, hash)) throw new AgentError(401, "Ключ не найден");
  if (row.revoked_at) throw new AgentError(403, "Ключ отозван");
  if (row.expires_at && new Date(row.expires_at) < new Date())
    throw new AgentError(403, "Срок действия ключа истёк");

  void supabaseAdmin
    .from("agent_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(() => undefined);

  return {
    keyId: row.id,
    teamId: row.team_id,
    name: row.name,
    scopes: (row.scopes ?? []) as AgentScope[],
  };
}

export function requireScope(agent: AgentContext, scope: AgentScope): void {
  if (!agent.scopes.includes(scope)) throw new AgentError(403, `Нет права ${scope}`);
}

/** Пишет действие агента в журнал команды. */
export async function logAgentAction(
  agent: AgentContext,
  action: string,
  targetType: string,
  targetId: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("audit_log").insert({
    team_id: agent.teamId,
    user_id: null,
    agent_key_id: agent.keyId,
    action,
    target_type: targetType,
    target_id: targetId,
    meta: { ...meta, agent: agent.name },
  });
}

/**
 * Простое ограничение частоты: не больше limit запросов в минуту на ключ.
 * Считается по журналу, поэтому переживает перезапуск сервера.
 */
export async function enforceRateLimit(agent: AgentContext, limit = 120): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await supabaseAdmin
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("agent_key_id", agent.keyId)
    .gte("created_at", since);
  // A failed limiter query must fail closed. Treating an unavailable audit
  // store as zero requests would turn a database incident into an unlimited
  // public API window.
  if (error) {
    console.error("agent rate-limit query failed", error);
    throw new AgentError(503, "Сервис временно недоступен");
  }
  if ((count ?? 0) >= limit) throw new AgentError(429, "Слишком много запросов, подождите минуту");

  // Record every authenticated request, including reads. This keeps the limit
  // effective for the whole public API instead of only mutation endpoints.
  const { error: insertError } = await supabaseAdmin.from("audit_log").insert({
    team_id: agent.teamId,
    user_id: null,
    agent_key_id: agent.keyId,
    action: "agent.request",
    target_type: "rate_limit",
    target_id: null,
    meta: { agent: agent.name },
  });
  if (insertError) {
    console.error("agent rate-limit write failed", insertError);
    throw new AgentError(503, "Сервис временно недоступен");
  }
}
