import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ArchiveRestore, Bot, ChevronDown, Download, Globe, LayoutGrid, ListChecks, LogOut, Monitor, PanelLeftClose, PanelLeftOpen, RefreshCw, Users } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useWorkspace, useWorkspaceSelection, WorkspaceProvider } from "@/lib/useWorkspace";
import { usePresenceHeartbeat } from "@/hooks/usePresenceHeartbeat";
import { useRealtimeSync } from "@/lib/useRealtimeSync";
import { DesktopProfileProvider, useDesktopProfileLifecycle } from "@/hooks/useDesktopProfileLifecycle";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FoldersNav } from "@/components/folders-nav";
import { ProfileFolderProvider } from "@/lib/useProfileFolder";
import { ImpersonationControl } from "@/components/impersonation-control";
import { ProfileDndProvider } from "@/components/profile-dnd";

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
  { to: "/app/trash", label: "Корзина", icon: ArchiveRestore, exact: false },
] as const;

const APP_NAV = [
  { to: "/app/desktop", label: "Обновления", icon: Download },
  { to: "/app/agents", label: "Агенты", icon: Bot },
  { to: "/app/audit", label: "Журнал", icon: ListChecks },
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
  return <WorkspaceProvider><DesktopProfileProvider><ProfileFolderProvider><ProfileDndProvider><AppShell /></ProfileDndProvider></ProfileFolderProvider></DesktopProfileProvider></WorkspaceProvider>;
}

function AppShell() {
  const workspace = useWorkspace();
  const ws = workspace.data;
  const selection = useWorkspaceSelection();
  const runtime = useDesktopProfileLifecycle();
  useRealtimeSync(ws?.teamId);
  usePresenceHeartbeat(ws?.teamId, runtime.running);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [appExpanded, setAppExpanded] = useState(false);
  useEffect(() => { setCollapsed(localStorage.getItem("umbra:sidebar") === "collapsed"); }, []);
  const toggleCollapsed = () => setCollapsed((value) => {
    const next = !value;
    try { localStorage.setItem("umbra:sidebar", next ? "collapsed" : "expanded"); } catch { /* приватный режим */ }
    return next;
  });
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => { if (APP_NAV.some((item) => pathname.startsWith(item.to))) setAppExpanded(true); }, [pathname]);
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await runtime.closeAll();
      const result = await supabase.auth.signOut();
      if (result.error) throw new Error();
      try { sessionStorage.removeItem("umbra:impersonation"); } catch { /* Нет доступа к хранилищу. */ }
      await qc.cancelQueries(); qc.clear();
      await navigate({ to: "/auth", replace: true });
    } catch { toast.error("Выход не выполнен. Проверьте синхронизацию профилей и подключение."); }
    finally { setSigningOut(false); }
  }
  return <div className="flex h-screen overflow-hidden bg-background">
    <aside className={"flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] " + (collapsed ? "w-14" : "w-56")}>
      <div className={"flex h-14 items-center gap-2 border-b border-sidebar-border " + (collapsed ? "justify-center" : "px-3")}>
        {collapsed ? <Button variant="ghost" size="icon" className="group relative size-9" title="Развернуть меню" aria-label="Развернуть меню" onClick={() => toggleCollapsed()}>
          <span className="flex size-6 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">U</span>
          <PanelLeftOpen className="absolute size-5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </Button> : <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">U</span>}
        {!collapsed && <><span className="text-sm font-semibold">Umbra</span>
          <Button variant="ghost" size="icon" className="ml-auto size-7" title="Свернуть меню" aria-label="Свернуть меню" onClick={() => toggleCollapsed()}><PanelLeftClose className="size-4" /></Button></>}
      </div>
      <nav className="scroll-thin flex flex-1 flex-col gap-1 overflow-y-auto p-2">{NAV.map((item) => {
        if (item.to === "/app/trash" && ws?.scope !== "owner") return null;
        const active = item.exact ? pathname === item.to || pathname === "/app/" : pathname.startsWith(item.to);
        const Icon = item.icon;
        return <Link key={item.to} to={item.to} title={item.label} aria-label={item.label} aria-current={active ? "page" : undefined}
          className={"flex items-center gap-3 rounded-md px-2 py-2 text-sm " + (collapsed ? "justify-center" : "") + " " + (active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}>
          <Icon className={"size-4 shrink-0 " + (active ? "text-primary" : "")} />{!collapsed && <span>{item.label}</span>}
        </Link>;
      })}
        <FoldersNav collapsed={collapsed} />
        <div className="mt-2 border-t border-sidebar-border pt-2">
          <button type="button" aria-label="Приложение" aria-expanded={appExpanded} title="Приложение" onClick={() => setAppExpanded((value) => !value)}
            className={"flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-sidebar-accent/60 " + (collapsed ? "justify-center" : "") + (APP_NAV.some((item) => pathname.startsWith(item.to)) ? " bg-sidebar-accent text-sidebar-accent-foreground" : " text-muted-foreground")}>
            <Monitor className="size-4 shrink-0" />{!collapsed && <><span>Приложение</span><ChevronDown className={"ml-auto size-4 transition-transform " + (appExpanded ? "rotate-180" : "")} /></>}
          </button>
          {appExpanded && <div className={"flex flex-col gap-0.5 " + (collapsed ? "" : "pl-4")}>{APP_NAV.map((item) => {
            const Icon = item.icon;
            const active = pathname.startsWith(item.to);
            return <Link key={item.to} to={item.to} title={item.label} aria-label={item.label} aria-current={active ? "page" : undefined}
              className={"flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-sidebar-accent/60 " + (collapsed ? "justify-center" : "") + (active ? " bg-sidebar-accent text-sidebar-accent-foreground" : " text-muted-foreground")}>
              <Icon className="size-4 shrink-0" />{!collapsed && item.label}
            </Link>;
          })}</div>}
        </div>
      </nav>
      <div className="border-t border-sidebar-border p-2">
        <div className={"min-w-0 space-y-2 " + (collapsed ? "hidden" : "block")}>
          <p className="truncate text-xs">{ws?.email ?? ""}</p>
          <Select value={ws?.teamId ?? ""} disabled={selection.workspaces.isPending || signingOut} onValueChange={selection.select}>
            <SelectTrigger aria-label="Рабочая команда" className="w-full text-xs"><SelectValue placeholder="Команда" /></SelectTrigger>
            <SelectContent>{(selection.workspaces.data?.length ? selection.workspaces.data : ws ? [ws] : []).map((team) => <SelectItem key={team.teamId} value={team.teamId}>{team.teamName}</SelectItem>)}</SelectContent>
          </Select>
          {selection.workspaces.isError && <Button size="sm" variant="ghost" onClick={() => selection.workspaces.refetch()}>Повторить загрузку команд</Button>}
          <p className="text-xs text-muted-foreground">{ws?.scope === "owner" ? "Владелец" : ws?.scope === "manager" ? "Администратор" : ws ? "Сотрудник" : ""}</p>
          <ImpersonationControl workspace={ws} closeProfiles={runtime.closeAll} />
        </div>
        <Button variant="ghost" size="sm" title="Выйти" aria-label="Выйти" disabled={signingOut || !runtime.ready} className={"mt-2 w-full " + (collapsed ? "px-0" : "justify-start px-2")} onClick={signOut}><LogOut className="size-4" />{!collapsed && <span>{signingOut ? "Сохранение…" : "Выйти"}</span>}</Button>
      </div>
    </aside>
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <UpdateBar /><LifecycleBar />
      <div className="border-b border-border p-2 md:hidden"><Select value={ws?.teamId ?? ""} disabled={signingOut} onValueChange={selection.select}><SelectTrigger aria-label="Рабочая команда"><SelectValue placeholder="Команда" /></SelectTrigger><SelectContent>{(selection.workspaces.data?.length ? selection.workspaces.data : ws ? [ws] : []).map((team) => <SelectItem key={team.teamId} value={team.teamId}>{team.teamName}</SelectItem>)}</SelectContent></Select></div>
      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto px-3 py-4 lg:px-5"><Outlet key={ws?.teamId ?? "loading"} /></main>
    </div>
  </div>;
}
