import { createFileRoute } from "@tanstack/react-router";
import { authenticateAgent, enforceRateLimit, jsonError, jsonResponse } from "@/lib/agent-auth.server";

export const Route = createFileRoute("/api/public/agent/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const agent = await authenticateAgent(request);
          await enforceRateLimit(agent);
          return jsonResponse({
            agent: agent.name,
            teamId: agent.teamId,
            scopes: agent.scopes,
          });
        } catch (err) {
          return jsonError(err);
        }
      },
    },
  },
});
