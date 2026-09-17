import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.fetchQuery({
      queryKey: ["authenticated-user"], staleTime: 30_000, retry: false,
      queryFn: async () => {
        // Локальная сессия отвечает мгновенно; запрос к серверу — только если её нет.
        const { data: local } = await supabase.auth.getSession();
        if (local.session?.user) return local.session.user;
        const { data, error } = await supabase.auth.getUser();
        if (error || !data.user) throw redirect({ to: "/auth" });
        return data.user;
      },
    });
    return { user };
  },
  component: () => <Outlet />,
});
