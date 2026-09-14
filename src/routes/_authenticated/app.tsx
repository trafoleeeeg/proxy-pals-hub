import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace } from "@/lib/useWorkspace";
import { desktop, type UpdateStatus } from "@/lib/desktop";
import { Button } from "@/components/ui/button";

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
  { to: "/app", label: "Профили", icon: "▢", exact: true },
  { to: "/app/proxies", label: "Прокси", icon: "◇", exact: false },
  { to: "/app/team", label: "Команда", icon: "◎", exact: false },
  { to: "/app/desktop", label: "Приложение", icon: "⬓", exact: false },
] as const;

function UpdateBar() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const b = desktop();
    if (!b) return;
    void b.appVersion().then(setVersion);
    const off = b.onUpdateStatus(setStatus);
    void b.checkUpdate();
    return off;
  }, []);

  const bridge = desktop();
  if (!bridge) return null;

  const show =
    status?.state === "available" ||
    status?.state === "downloading" ||
    status?.state === "downloaded";
  if (!show) return null;

  return (
    <div className="flex items-center gap-3 border-b border-border bg-primary/10 px-6 py-2 text-sm">
      <span className="text-foreground">
        {status.state === "available" && `Доступна новая версия ${status.version}`}
        {status.state === "downloading" && `Загрузка обновления… ${status.percent}%`}
        {status.state === "downloaded" &&
          `Версия ${status.version} загружена — профили и данные сохранятся`}
      </span>
      <span className="mono text-xs text-muted-foreground">сейчас {version ?? "…"}</span>
      <div className="ml-auto">
        {status.state === "available" && (
          <Button size="sm" onClick={() => bridge.downloadUpdate()}>
            Обновить
          </Button>
        )}
        {status.state === "downloaded" && (
          <Button size="sm" onClick={() => bridge.installUpdate()}>
            Установить и перезапустить
          </Button>
        )}
      </div>
    </div>
  );
}

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
    <div className="flex min-h-screen bg-background">
      <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-5">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
            U
          </span>
          <span className="text-sm font-semibold tracking-tight">Umbra</span>
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-3">
          {NAV.map((item) => {
            const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
                }`}
              >
                <span className={active ? "text-primary" : ""}>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className="rounded-md bg-sidebar-accent/50 px-3 py-2">
            <p className="truncate text-xs font-medium">{ws?.email ?? "—"}</p>
            <p className="mono text-[11px] text-muted-foreground">
              {ws ? (ws.role === "owner" ? "владелец" : "сотрудник") : ""} · {ws?.teamName ?? ""}
            </p>
          </div>
          <Button variant="ghost" size="sm" className="mt-2 w-full justify-start" onClick={signOut}>
            Выйти
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <UpdateBar />
        <main className="flex-1 px-8 py-7">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
