import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  AgentError,
  authenticateAgent,
  enforceRateLimit,
  jsonError,
  logAgentAction,
  requireScope,
} from "@/lib/agent-auth.server";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  folder: z.string().trim().max(80).optional(),
  tags: z.array(z.string().trim().max(40)).max(20).optional(),
  notes: z.string().max(2000).optional(),
  proxyId: z.string().uuid().nullable().optional(),
});

async function ownedProfile(teamId: string, id: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("browser_profiles")
    .select("id")
    .eq("id", id)
    .eq("team_id", teamId)
    .maybeSingle();
  if (!data) throw new AgentError(404, "Профиль не найден");
  return supabaseAdmin;
}

export const Route = createFileRoute("/api/public/agent/profiles/$id")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        try {
          const agent = await authenticateAgent(request);
          requireScope(agent, "profiles:write");
          await enforceRateLimit(agent);

          const parsed = patchSchema.safeParse(await request.json());
          if (!parsed.success)
            throw new AgentError(400, parsed.error.issues.map((i) => i.message).join("; "));

          const db = await ownedProfile(agent.teamId, params.id);
          const patch: {
            name?: string;
            folder?: string;
            tags?: string[];
            notes?: string;
            proxy_id?: string | null;
          } = {};
          if (parsed.data.name !== undefined) patch.name = parsed.data.name;
          if (parsed.data.folder !== undefined) patch.folder = parsed.data.folder;
          if (parsed.data.tags !== undefined) patch.tags = parsed.data.tags;
          if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
          if (parsed.data.proxyId !== undefined) patch.proxy_id = parsed.data.proxyId;
          if (Object.keys(patch).length === 0) throw new AgentError(400, "Нечего менять");

          const { error } = await db.from("browser_profiles").update(patch).eq("id", params.id);
          if (error) throw new AgentError(500, error.message);

          await logAgentAction(agent, "profile.updated", "profile", params.id, patch);
          return Response.json({ ok: true });
        } catch (err) {
          return jsonError(err);
        }
      },

      DELETE: async ({ request, params }) => {
        try {
          const agent = await authenticateAgent(request);
          requireScope(agent, "profiles:write");
          await enforceRateLimit(agent);

          const db = await ownedProfile(agent.teamId, params.id);
          const { error } = await db.from("browser_profiles").delete().eq("id", params.id);
          if (error) throw new AgentError(500, error.message);

          await logAgentAction(agent, "profile.deleted", "profile", params.id);
          return Response.json({ ok: true });
        } catch (err) {
          return jsonError(err);
        }
      },
    },
  },
});
