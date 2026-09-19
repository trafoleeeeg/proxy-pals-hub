import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, requireTeamAccess } from "./server-db";

const teamId = z.string().uuid();
const color = z.enum(["primary", "success", "warning", "destructive", "muted"]);
const fieldType = z.enum(["text", "number", "date", "url"]);

export const listProfileMetadata = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ teamId }).strict().parse(data))
  .handler(async ({ data, context }) => {
    await requireTeamAccess(context, data.teamId);
    const [statuses, fields] = await Promise.all([
      context.supabase.from("profile_statuses").select("id, name, color, position").eq("team_id", data.teamId).order("position").order("created_at"),
      context.supabase.from("profile_field_definitions").select("id, name, field_type, position").eq("team_id", data.teamId).order("position").order("created_at"),
    ]);
    if (statuses.error || fields.error) throw new Error("Не удалось загрузить настройки профилей");
    return { statuses: statuses.data ?? [], fields: fields.data ?? [] };
  });

export const createProfileStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ teamId, name: z.string().trim().min(1).max(80), color }).strict().parse(data))
  .handler(async ({ data, context }) => {
    await requirePermission(context, data.teamId, "profile.edit");
    const { data: row, error } = await context.supabase.from("profile_statuses")
      .insert({ team_id: data.teamId, name: data.name, color: data.color }).select("id, name, color, position").single();
    if (error) throw new Error(error.code === "23505" ? "Такой статус уже существует" : "Не удалось добавить статус");
    return row;
  });

export const createProfileField = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => z.object({ teamId, name: z.string().trim().min(1).max(80), fieldType }).strict().parse(data))
  .handler(async ({ data, context }) => {
    await requirePermission(context, data.teamId, "profile.edit");
    const { data: row, error } = await context.supabase.from("profile_field_definitions")
      .insert({ team_id: data.teamId, name: data.name, field_type: data.fieldType }).select("id, name, field_type, position").single();
    if (error) throw new Error(error.code === "23505" ? "Такая колонка уже существует" : "Не удалось добавить колонку");
    return row;
  });