import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { recoverVerifiedUser } from "@/lib/panel-connectivity";
import type { User } from "@supabase/supabase-js";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ context }) => {
    const user = await recoverVerifiedUser(() => context.queryClient.fetchQuery({
      queryKey: ["authenticated-user"], staleTime: 30_000, gcTime: Infinity, retry: false,
      queryFn: async () => {
        // A locally persisted user is not proof that its access/refresh token
        // is still accepted. Validate it before protected queries can mount.
        const user = await getAuthenticatedUser();
        if (!user) throw redirect({ to: "/auth", search: { next: "/app" } });
        return user;
      },
    }), context.queryClient.getQueryData<User>(["authenticated-user"]));
    return { user };
  },
  component: () => <Outlet />,
});
