import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Bot, Download, Globe, LayoutGrid, LogOut, Monitor, RefreshCw, Users } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace, useWorkspaceSelection, WorkspaceProvider } from "@/lib/useWorkspace";
import { DesktopProfileProvider, useDesktopProfileLifecycle } from "@/hooks/useDesktopProfileLifecycle";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FoldersNav } from "@/components/folders-nav";
import { ProfileFolderProvider } from "@/lib/useProfileFolder";

export const Route = createFileRoute("/_authenticated/app")({
  head: () => ({ meta: [
    { title: "Панель Umbra" },
    { name: "description", content: "Управление профилями, прокси и командой." },
    { property: "og:title", content: "Панель Umbra" },
    { property: "og:description", content: "Управление профилями, прокси и командой." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] }),
  component: AppLayout,
});

const NAV = [
  { to: "/app", label: "Профили", icon: LayoutGrid, exact: true },
  { to: "/app/proxies", label: "Прокси", icon: Globe, exact: false },
  { to: "/app/team", label: "Команда", icon: Users, exact: false },
  { to: "/app/agents", label: "Агенты", icon: Bot, exact: false },
  { to: "/app/desktop", label: "Приложение", icon: Monitor, exact: false },
] as const;

function UpdateBar() {
  const { available, update, updateAction } = useDesktopProfileLifecycle();
  const { status, busy, error } = update;
  if (!available || (!error && status?.state !== "available" && status?.state !== "downloading" && status?.state !== "downloaded")) return null;
  return <div className="flex flex-wrap items-center gap-3 border-b border-border bg-secondary/40 px-4 py-2 text-sm" role={error ? "alert" : "status"}>
    <span className={error ? "min-w-0 break-words text-destructive" : "min-w-0 break-words"}>
      {error || (status?.state === "available" ? "Доступна версия " + status.version : status?.state === "downloading" ? "Загрузка обновления: " + status.percent + "%" : status?.state === "downloaded" ? "Версия " + status.version + " готова к установке" : "")}
    </span>
    <div className="ml-auto flex gap-2">
      {status?.state === "available" && <Button size="sm" disabled={busy} onClick={() => updateAction("download")}><Download className="size-4" />Скачать</Button>}
      {status?.state === "downloaded" && <Button size="sm" disabled={busy} onClick={() => updateAction("install")}>Установить и перезапустить</Button>}
      {error && <Button size="icon" variant="outline" title="Проверить обновление повторно" aria-label="Проверить обновление повторно" disabled={busy} onClick={() => updateAction("check")}><RefreshCw className="size-4" /></Button>}
    </div>
  </div>;
}

function LifecycleBar() {
  const runtime = useDesktopProfileLifecycle();
  const [busy, setBusy] = useState(false);
  const messages = [...new Set(Object.values(runtime.errors))];
  const notices = [...new Set(Object.values(runtime.notices))];
  if (!runtime.available || (!messages.length && !notices.length && !runtime.restoring && !runtime.pending.length)) return null;
  async function retry() {
    setBusy(true);
    try { await runtime.retry(); }
    catch { toast.error("Синхронизация не завершена. Проверьте подключение."); }
    finally { setBusy(false); }
  }
  return <div className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-2 text-sm" role={messages.length ? "alert" : "status"}>
    <div className="min-w-0 flex-1 space-y-1">
      {runtime.restoring && <p>Восстановление открытых профилей…</p>}
      {runtime.pending.length > 0 && <p className="text-warning">Ожидают сохранения: {runtime.pending.length}</p>}
      {messages.map((message) => <p key={message} className="break-words text-destructive">{message}</p>)}
      {notices.map((notice) => <p key={notice} className="break-words text-muted-foreground">{notice}</p>)}
    </div>
    {(messages.length > 0 || runtime.pending.length > 0) && <Button variant="outline" size="sm" disabled={busy || runtime.restoring} onClick={retry}><RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />Повторить</Button>}
  </div>;
}

export function AppLayout() {
  return <WorkspaceProvider><DesktopProfileProvider><ProfileFolderProvider><AppShell /></ProfileFolderProvider></DesktopProfileProvider></WorkspaceProvider>;
}

function AppShell() {
  const workspace = useWorkspace();
  const ws = workspace.data;
  const selection = useWorkspaceSelection();
  const runtime = useDesktopProfileLifecycle();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await runtime.closeAll();
      const result = await supabase.auth.signOut();
      if (result.error) throw new Error();
      await qc.cancelQueries(); qc.clear();
      await navigate({ to: "/auth", replace: true });
    } catch { toast.error("Выход не выполнен. Проверьте синхронизацию профилей и подключение."); }
    finally { setSigningOut(false); }
  }
  return <div className="flex min-h-screen bg-background">
    <aside className="flex w-14 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:w-56">
      <div className="flex h-14 items-center justify-center gap-2 border-b border-sidebar-border md:justify-start md:px-4">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">U</span>
        <span className="hidden text-sm font-semibold md:inline">Umbra</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2 md:p-3">{NAV.map((item) => {
        const active = item.exact ? pathname === item.to || pathname === "/app/" : pathname.startsWith(item.to);
        const Icon = item.icon;
        return <Link key={item.to} to={item.to} title={item.label} aria-label={item.label} aria-current={active ? "page" : undefined}
          className={"flex items-center justify-center gap-3 rounded-md px-2 py-2 text-sm md:justify-start " + (active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}>
          <Icon className={"size-4 shrink-0 " + (active ? "text-primary" : "")} /><span className="hidden md:inline">{item.label}</span>
        </Link>;
      })}
        {(pathname === "/app" || pathname === "/app/") && <FoldersNav />}
      </nav>
      <div className="border-t border-sidebar-border p-2 md:p-3">
        <div className="hidden min-w-0 space-y-2 md:block">
          <p className="truncate text-xs">{ws?.email ?? ""}</p>
          <Select value={ws?.teamId ?? ""} disabled={selection.workspaces.isPending || signingOut} onValueChange={selection.select}>
            <SelectTrigger aria-label="Рабочая команда" className="w-full text-xs"><SelectValue placeholder="Команда" /></SelectTrigger>
            <SelectContent>{(selection.workspaces.data?.length ? selection.workspaces.data : ws ? [ws] : []).map((team) => <SelectItem key={team.teamId} value={team.teamId}>{team.teamName}</SelectItem>)}</SelectContent>
          </Select>
          {selection.workspaces.isError && <Button size="sm" variant="ghost" onClick={() => selection.workspaces.refetch()}>Повторить загрузку команд</Button>}
          <p className="text-xs text-muted-foreground">{ws?.role === "owner" ? "Владелец" : ws ? "Сотрудник" : ""}</p>
        </div>
        <Button variant="ghost" size="sm" title="Выйти" aria-label="Выйти" disabled={signingOut || !runtime.ready} className="mt-2 w-full px-0 md:justify-start md:px-2" onClick={signOut}><LogOut className="size-4" /><span className="hidden md:inline">{signingOut ? "Сохранение…" : "Выйти"}</span></Button>
      </div>
    </aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <UpdateBar /><LifecycleBar />
      <div className="border-b border-border p-2 md:hidden"><Select value={ws?.teamId ?? ""} disabled={signingOut} onValueChange={selection.select}><SelectTrigger aria-label="Рабочая команда"><SelectValue placeholder="Команда" /></SelectTrigger><SelectContent>{(selection.workspaces.data?.length ? selection.workspaces.data : ws ? [ws] : []).map((team) => <SelectItem key={team.teamId} value={team.teamId}>{team.teamName}</SelectItem>)}</SelectContent></Select></div>
      <main className="min-w-0 flex-1 px-3 py-5 lg:px-6"><Outlet key={ws?.teamId ?? "loading"} /></main>
    </div>
  </div>;
}
