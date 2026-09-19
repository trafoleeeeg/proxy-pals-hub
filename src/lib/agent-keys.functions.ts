import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AgentKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
};

async function assertOwner(
  ctx: { supabase: import("@supabase/supabase-js").SupabaseClient; userId: string },
  teamId: string,
) {
  const { data: superadmin } = await ctx.supabase.rpc("is_superadmin");
  if (superadmin === true) return;
  const { data: team } = await ctx.supabase
    .from("teams")
    .select("owner_id")
    .eq("id", teamId)
    .maybeSingle();
  if ((team as { owner_id?: string } | null)?.owner_id === ctx.userId) return;
  const { data } = await ctx.supabase
    .from("team_members")
    .select("role")
    .eq("team_id", teamId)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if ((data as { role?: string } | null)?.role !== "owner") throw new Error("Доступ только для владельца команды");
}

export const listAgentKeys = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { teamId: string }) => d)
  .handler(async ({ data, context }): Promise<AgentKeyRow[]> => {
    await assertOwner(context, data.teamId);
    const { data: rows, error } = await context.supabase
      .from("agent_keys")
      .select("id, name, key_prefix, scopes, expires_at, revoked_at, last_used_at, created_at")
      .eq("team_id", data.teamId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

/** Создаёт ключ. Сам ключ возвращается один раз и нигде больше не хранится. */
export const createAgentKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { teamId: string; name: string; scopes: string[]; days: number | null }) => d)
  .handler(async ({ data, context }) => {
    await assertOwner(context, data.teamId);
    const { generateAgentKey, AGENT_SCOPES } = await import("./agent-auth.server");

    const scopes = data.scopes.filter((s) => (AGENT_SCOPES as readonly string[]).includes(s));
    if (scopes.length === 0) throw new Error("Выберите хотя бы одно право");

    const { key, hash, prefix } = generateAgentKey();
    const expires =
      data.days && data.days > 0
        ? new Date(Date.now() + data.days * 86_400_000).toISOString()
        : null;

    const { data: row, error } = await context.supabase
      .from("agent_keys")
      .insert({
        team_id: data.teamId,
        name: data.name.trim() || "Агент",
        key_hash: hash,
        key_prefix: prefix,
        scopes,
        created_by: context.userId,
        expires_at: expires,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    await context.supabase.from("audit_log").insert({
      team_id: data.teamId,
      user_id: context.userId,
      action: "agent_key.created",
      target_type: "agent_key",
      target_id: row.id,
      meta: { name: data.name, scopes },
    });

    return { id: row.id, key };
  });

export const revokeAgentKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { teamId: string; id: string }) => d)
  .handler(async ({ data, context }) => {
    await assertOwner(context, data.teamId);
    const { error } = await context.supabase
      .from("agent_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("team_id", data.teamId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteAgentKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { teamId: string; id: string }) => d)
  .handler(async ({ data, context }) => {
    await assertOwner(context, data.teamId);
    const { error } = await context.supabase
      .from("agent_keys")
      .delete()
      .eq("id", data.id)
      .eq("team_id", data.teamId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Последние действия агентов — для вкладки «Агенты». */
export const listAgentActivity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { teamId: string }) => d)
  .handler(async ({ data, context }) => {
    await assertOwner(context, data.teamId);
    const { data: rows, error } = await context.supabase
      .from("audit_log")
      .select("id, action, target_type, target_id, meta, created_at, agent_key_id")
      .eq("team_id", data.teamId)
      .not("agent_key_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return rows ?? [];
  });
