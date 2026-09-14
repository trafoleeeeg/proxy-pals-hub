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
import { generateFingerprint } from "@/lib/fingerprint";
import type { Json } from "@/integrations/supabase/types";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  folder: z.string().trim().max(80).default(""),
  tags: z.array(z.string().trim().max(40)).max(20).default([]),
  notes: z.string().max(2000).default(""),
  proxyId: z.string().uuid().nullable().default(null),
  country: z.string().trim().length(2).optional(),
  count: z.number().int().min(1).max(50).default(1),
});

export const Route = createFileRoute("/api/public/agent/profiles")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const agent = await authenticateAgent(request);
          requireScope(agent, "profiles:read");
          await enforceRateLimit(agent);

          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data, error } = await supabaseAdmin
            .from("browser_profiles")
            .select("id, name, folder, tags, notes, proxy_id, fingerprint, created_at, updated_at")
            .eq("team_id", agent.teamId)
            .order("created_at", { ascending: false })
            .limit(500);
          if (error) throw new AgentError(500, error.message);

          // Cookies и пароли наружу не отдаём никогда.
          return Response.json({ profiles: data ?? [] });
        } catch (err) {
          return jsonError(err);
        }
      },

      POST: async ({ request }) => {
        try {
          const agent = await authenticateAgent(request);
          requireScope(agent, "profiles:write");
          await enforceRateLimit(agent);

          const parsed = createSchema.safeParse(await request.json());
          if (!parsed.success)
            throw new AgentError(400, parsed.error.issues.map((i) => i.message).join("; "));
          const input = parsed.data;

          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

          if (input.proxyId) {
            const { data: proxy } = await supabaseAdmin
              .from("proxies")
              .select("id")
              .eq("id", input.proxyId)
              .eq("team_id", agent.teamId)
              .maybeSingle();
            if (!proxy) throw new AgentError(400, "Прокси не найден в этой команде");
          }

          const rows = Array.from({ length: input.count }, (_, i) => ({
            team_id: agent.teamId,
            name: input.count > 1 ? `${input.name} ${i + 1}` : input.name,
            folder: input.folder,
            tags: input.tags,
            notes: input.notes,
            proxy_id: input.proxyId,
            fingerprint: generateFingerprint(input.country ?? null) as unknown as Json,
          }));

          const { data, error } = await supabaseAdmin
            .from("browser_profiles")
            .insert(rows)
            .select("id, name");
          if (error) throw new AgentError(500, error.message);

          await logAgentAction(agent, "profile.created", "profile", data?.[0]?.id ?? null, {
            count: data?.length ?? 0,
          });
          return Response.json({ created: data ?? [] }, { status: 201 });
        } catch (err) {
          return jsonError(err);
        }
      },
    },
  },
});
