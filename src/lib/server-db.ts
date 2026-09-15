import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

type Rpc<Args, Returns> = { Args: Args; Returns: Returns };
type LeaseResult = { lockToken: string; expiresAt: string; cookiesUpdatedAt: string };
type MigrationFunctions = {
  acquire_profile_lease: Rpc<{ _profile_id: string; _device_id: string; _device_label: string | null }, LeaseResult>;
  mutate_profile_lease: Rpc<{ _profile_id: string; _lock_token: string; _operation: "save" | "heartbeat" | "close"; _cookies_enc: string | null; _device_id: string | null }, { expiresAt: string; cookiesUpdatedAt: string }>;
  force_profile_unlock: Rpc<{ _profile_id: string }, boolean>;
  import_profile_cookies: Rpc<{ _profile_id: string; _cookies_enc: string }, string>;
  bulk_mutate_profiles: Rpc<{ _team_id: string; _profile_ids: string[]; _operation: "update" | "delete"; _changes: Json }, number>;
  set_profiles_access: Rpc<{ _team_id: string; _profile_ids: string[]; _user_id: string; _granted: boolean }, number>;
  remove_team_member: Rpc<{ _team_id: string; _user_id: string }, boolean>;
  accept_team_invite: Rpc<{ _token: string }, string>;
  ensure_workspace: Rpc<Record<string, never>, string>;
};

// Local migration contract until Supabase regenerates its integration files.
type ServerDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Functions" | "Tables"> & {
    Functions: Database["public"]["Functions"] & MigrationFunctions;
    Tables: Omit<Database["public"]["Tables"], "browser_profiles"> & {
      browser_profiles: Omit<Database["public"]["Tables"]["browser_profiles"], "Row"> & {
        Row: Database["public"]["Tables"]["browser_profiles"]["Row"] & { cookies_updated_at: string };
      };
    };
  };
};
export function serverDb(client: SupabaseClient<Database>): SupabaseClient<ServerDatabase> {
  return client as unknown as SupabaseClient<ServerDatabase>;
}
export async function callServerRpc<K extends keyof MigrationFunctions>(client: SupabaseClient<Database>, name: K, args: MigrationFunctions[K]["Args"]): Promise<MigrationFunctions[K]["Returns"]> {
  // Isolate the generated-client mismatch; every caller uses the explicit RPC contract.
  const rpc = client.rpc.bind(client) as unknown as (name: K, args: MigrationFunctions[K]["Args"]) => PromiseLike<{ data: MigrationFunctions[K]["Returns"] | null; error: { message: string } | null }>;
  const { data, error } = await rpc(name, args);
  if (error) throw new Error(error.message);
  if (data === null) throw new Error("Server operation returned no result");
  return data;
}

export type ServerContext = { supabase: SupabaseClient<Database>; userId: string };
export async function requireTeamOwner(context: ServerContext, teamId: string) {
  const { data, error } = await context.supabase.from("teams").select("id, owner_id").eq("id", teamId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.owner_id !== context.userId) throw new Error("Доступ только для владельца команды");
  return data;
}
export async function requireTeamAccess(context: ServerContext, teamId: string) {
  const { data, error } = await context.supabase.from("teams").select("id").eq("id", teamId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Нет доступа к команде");
}
export async function requireProfile(context: ServerContext, profileId: string, owner = false) {
  const { data, error } = await context.supabase.from("browser_profiles").select("id, team_id").eq("id", profileId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Нет доступа к профилю");
  if (owner) await requireTeamOwner(context, data.team_id);
  return data;
}
export async function requireTeamProxy(context: ServerContext, teamId: string, proxyId: string | null | undefined) {
  if (!proxyId) return;
  const { data, error } = await context.supabase.from("proxies").select("id").eq("id", proxyId).eq("team_id", teamId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Прокси недоступен или принадлежит другой команде");
}
export async function writeAudit(context: ServerContext, teamId: string, action: string, targetId: string) {
  const { error } = await context.supabase.from("audit_log").insert({ team_id: teamId, user_id: context.userId, action, target_type: "profile", target_id: targetId });
  if (error) throw new Error(error.message);
}
