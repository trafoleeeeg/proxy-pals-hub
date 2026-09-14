import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/lib/useWorkspace";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/app")({
  head: () => ({
    meta: [
      { title: "Панель Umbra" },
      { name: "description", content: "Управление профилями, прокси и командой." },
      { property: "og:title", content: "Панель Umbra" },
      { property: "og:description", content: "Управление профилями, прокси и командой." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AppLayout,
});

const NAV = [
  { to: "/app", label: "Профили", exact: true },
  { to: "/app/proxies", label: "Прокси", exact: false },
  { to: "/app/team", label: "Команда", exact: false },
  { to: "/app/client", label: "Приложение", exact: false },
] as const;

function AppLayout() {
  const { data: ws } = useWorkspace();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
          <Link to="/app" className="mono text-sm font-semibold">
            UMBRA<span className="text-primary">.</span>
          </Link>
          <nav className="flex items-center gap-1">
            {NAV.map((item) => {
              const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {ws && (
              <Badge variant="outline" className="mono text-xs">
                {ws.role === "owner" ? "владелец" : "сотрудник"} · {ws.email}
              </Badge>
            )}
            <Button variant="ghost" size="sm" onClick={signOut}>
              Выйти
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
