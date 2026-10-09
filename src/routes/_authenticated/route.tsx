import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getPanelUser } from "@/lib/panel-bootstrap";
import { recoverVerifiedUser } from "@/lib/panel-connectivity";
import { panelAuthQueryOptions } from "@/lib/panel-query-recovery";
import type { User } from "@supabase/supabase-js";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ context }) => {
    const user = await recoverVerifiedUser(() => context.queryClient.fetchQuery(panelAuthQueryOptions(async () => {
      // A locally persisted user is not proof that its access/refresh token
      // is still accepted. Validate it before protected queries can mount.
      const user = await getPanelUser(context.queryClient);
      if (!user) throw redirect({ to: "/auth", search: { next: "/app" } });
      return user;
    })), context.queryClient.getQueryData<User>(["authenticated-user"]));
    return { user };
  },
  component: () => <Outlet />,
});
