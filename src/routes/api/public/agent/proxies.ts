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

const createSchema = z.object({
  label: z.string().trim().max(80).default(""),
  protocol: z.enum(["http", "https", "socks5"]),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().max(200).optional(),
  password: z.string().max(400).optional(),
  country: z.string().trim().length(2).optional(),
});

export const Route = createFileRoute("/api/public/agent/proxies")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const agent = await authenticateAgent(request);
          requireScope(agent, "proxies:read");
          await enforceRateLimit(agent);

          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data, error } = await supabaseAdmin
            .from("proxies")
            .select(
              "id, label, protocol, host, port, username, country, city, last_checked_at, last_check_ok, last_check_ip, last_check_latency_ms, password_enc",
            )
            .eq("team_id", agent.teamId)
            .order("created_at", { ascending: false })
            .limit(500);
          if (error) throw new AgentError(500, error.message);

          // Пароль прокси наружу не отдаём — только признак его наличия.
          return Response.json({
            proxies: (data ?? []).map(({ password_enc, ...rest }) => ({
              ...rest,
              hasPassword: Boolean(password_enc),
            })),
          });
        } catch (err) {
          return jsonError(err);
        }
      },

      POST: async ({ request }) => {
        try {
          const agent = await authenticateAgent(request);
          requireScope(agent, "proxies:write");
          await enforceRateLimit(agent);

          const parsed = createSchema.safeParse(await request.json());
          if (!parsed.success)
            throw new AgentError(400, parsed.error.issues.map((i) => i.message).join("; "));
          const input = parsed.data;

          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { encryptSecret } = await import("@/lib/crypto.server");

          const { data, error } = await supabaseAdmin
            .from("proxies")
            .insert({
              team_id: agent.teamId,
              label: input.label,
              protocol: input.protocol,
              host: input.host,
              port: input.port,
              username: input.username || null,
              country: input.country?.toUpperCase() || null,
              ...(input.password ? { password_enc: encryptSecret(input.password) } : {}),
            })
            .select("id")
            .single();
          if (error) throw new AgentError(500, error.message);

          await logAgentAction(agent, "proxy.created", "proxy", data.id, { host: input.host });
          return Response.json({ id: data.id }, { status: 201 });
        } catch (err) {
          return jsonError(err);
        }
      },
    },
  },
});
