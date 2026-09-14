import { createFileRoute } from "@tanstack/react-router";
import { authenticateAgent, jsonError } from "@/lib/agent-auth.server";

export const Route = createFileRoute("/api/public/agent/me")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const agent = await authenticateAgent(request);
          return Response.json({
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
