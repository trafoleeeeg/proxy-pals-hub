import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getAuthenticatedUser } from "@/integrations/supabase/auth-session";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.fetchQuery({
      queryKey: ["authenticated-user"], staleTime: 30_000, retry: false,
      queryFn: async () => {
        // A locally persisted user is not proof that its access/refresh token
        // is still accepted. Validate it before protected queries can mount.
        const user = await getAuthenticatedUser();
        if (!user) throw redirect({ to: "/auth", search: { next: "/app" } });
        return user;
      },
    });
    return { user };
  },
  component: () => <Outlet />,
});
