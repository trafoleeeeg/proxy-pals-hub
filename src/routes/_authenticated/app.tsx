import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Bot, ChevronDown, Download, Globe, Layers2, History, LogOut, Monitor, PanelLeftClose, PanelLeftOpen, RefreshCw, Trash2, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { employeePreview, leaveEmployeePreview, supabase } from "@/lib/app-supabase";
import { queueEmployeeExit } from "@/lib/employee-session-storage";
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
import { CookieRecoveryAction } from "@/components/cookie-recovery";

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
  { to: "/app", label: "Профили", icon: Layers2, exact: true },
  { to: "/app/proxies", label: "Прокси", icon: Globe, exact: false },
  { to: "/app/team", label: "Команда", icon: UsersRound, exact: false },
  { to: "/app/trash", label: "Корзина", icon: Trash2, exact: false },
] as const;

const APP_NAV = [
  { to: "/app/desktop", label: "Обновления", icon: Download },
  { to: "/app/agents", label: "Агенты", icon: Bot },
  { to: "/app/audit", label: "Журнал", icon: History },
] as const;

function UpdateBar() {
  const { available, update, updateAction } = useDesktopProfileLifecycle();
  const { status, busy, error } = update;
  // Background update-check failures belong to the Updates section, not the
  // workspace. Installation/download progress and explicit install errors stay visible.
  if (!available || (status?.state !== "available" && status?.state !== "downloading" && status?.state !== "downloaded")) return null;
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
  const recoveries = Object.keys(runtime.recoveries || {});
  const hasRetry = runtime.pending.length > 0 || Object.keys(runtime.errors).some(id => !recoveries.includes(id));
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
      {recoveries.length > 0 && <div className="flex flex-wrap gap-2 pt-1">{recoveries.map(id => <CookieRecoveryAction key={id} profileId={id} />)}</div>}
    </div>
    {hasRetry && <Button variant="outline" size="sm" disabled={busy || runtime.restoring} onClick={retry}><RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />Повторить</Button>}
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
  useEffect(() => {
    const compact = window.matchMedia("(max-width: 639px)").matches;
    try {
      const preference = localStorage.getItem("umbra:sidebar");
      setCollapsed(preference ? preference === "collapsed" : compact);
    } catch { setCollapsed(compact); }
  }, []);
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
      const preview = employeePreview();
      if (preview) {
        // Leaving an operator's preview must not globally revoke the employee's
        // own sessions or remove the original persistent operator login.
        queueEmployeeExit(sessionStorage, preview);
        await leaveEmployeePreview();
        window.location.assign("/app");
        return;
      }
      const result = await supabase.auth.signOut();
      if (result.error) throw new Error();
      try { sessionStorage.removeItem("umbra:impersonation"); } catch { /* Нет доступа к хранилищу. */ }
      await qc.cancelQueries(); qc.clear();
      await navigate({ to: "/auth", replace: true });
    } catch { toast.error("Выход не выполнен. Проверьте синхронизацию профилей и подключение."); }
    finally { setSigningOut(false); }
  }
  return <div className="umbra-workspace flex h-dvh overflow-hidden bg-sidebar">
    <aside aria-label="Боковая панель" className={"flex shrink-0 flex-col bg-sidebar transition-[width] duration-200 ease-out " + (collapsed ? "w-16" : "w-60 max-sm:w-52")}>
      <div className={"flex h-16 shrink-0 items-center gap-2.5 " + (collapsed ? "justify-center" : "px-4")}>
        {collapsed ? <Button variant="ghost" size="icon" className="group relative size-9" title="Развернуть меню" aria-label="Развернуть меню" onClick={() => toggleCollapsed()}>
          <span className="flex size-7 items-center justify-center rounded-lg bg-sidebar-accent text-xs font-semibold text-sidebar-foreground transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">U</span>
          <PanelLeftOpen className="absolute size-5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </Button> : <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-xs font-semibold text-sidebar-foreground">U</span>}
        {!collapsed && <><span className="text-base font-semibold tracking-tight">Umbra</span>
          <Button variant="ghost" size="icon" className="ml-auto size-7 text-muted-foreground" title="Свернуть меню" aria-label="Свернуть меню" onClick={() => toggleCollapsed()}><PanelLeftClose className="size-4" /></Button></>}
      </div>
      <nav aria-label="Разделы приложения" className="scroll-thin flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3">{NAV.map((item) => {
        if (item.to === "/app/trash" && ws?.scope !== "owner") return null;
        const active = item.exact ? pathname === item.to || pathname === "/app/" : pathname.startsWith(item.to);
        const Icon = item.icon;
        return <Link key={item.to} to={item.to} title={item.label} aria-label={item.label} aria-current={active ? "page" : undefined}
          className={"flex h-10 shrink-0 items-center gap-3 rounded-lg px-3 text-sm transition-colors " + (collapsed ? "justify-center px-0" : "") + " " + (active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}>
          <Icon className="size-[18px] shrink-0" />{!collapsed && <span>{item.label}</span>}
        </Link>;
      })}
        <FoldersNav collapsed={collapsed} />
        <div className="mt-3 shrink-0 border-t border-sidebar-border/70 pt-3">
          <button type="button" aria-label="Приложение" aria-expanded={appExpanded} title="Приложение" onClick={() => setAppExpanded((value) => !value)}
            className={"flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm transition-colors hover:bg-sidebar-accent/60 " + (collapsed ? "justify-center px-0" : "") + (APP_NAV.some((item) => pathname.startsWith(item.to)) ? " bg-sidebar-accent text-sidebar-accent-foreground" : " text-muted-foreground")}>
            <Monitor className="size-4 shrink-0" />{!collapsed && <><span>Приложение</span><ChevronDown className={"ml-auto size-4 transition-transform " + (appExpanded ? "rotate-180" : "")} /></>}
          </button>
          {appExpanded && <div className={"flex flex-col gap-0.5 " + (collapsed ? "" : "pl-4")}>{APP_NAV.map((item) => {
            const Icon = item.icon;
            const active = pathname.startsWith(item.to);
            return <Link key={item.to} to={item.to} title={item.label} aria-label={item.label} aria-current={active ? "page" : undefined}
              className={"flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent/60 " + (collapsed ? "justify-center px-0" : "") + (active ? " bg-sidebar-accent text-sidebar-accent-foreground" : " text-muted-foreground")}>
              <Icon className="size-4 shrink-0" />{!collapsed && item.label}
            </Link>;
          })}</div>}
        </div>
      </nav>
      <div className="mx-3 shrink-0 border-t border-sidebar-border/70 py-3">
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
    <div data-testid="workspace-surface" className="my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/70 bg-background">
      <UpdateBar /><LifecycleBar />
      <div className="border-b border-border p-2 md:hidden"><Select value={ws?.teamId ?? ""} disabled={signingOut} onValueChange={selection.select}><SelectTrigger aria-label="Рабочая команда"><SelectValue placeholder="Команда" /></SelectTrigger><SelectContent>{(selection.workspaces.data?.length ? selection.workspaces.data : ws ? [ws] : []).map((team) => <SelectItem key={team.teamId} value={team.teamId}>{team.teamName}</SelectItem>)}</SelectContent></Select></div>
      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto px-4 py-5 lg:px-6"><Outlet key={ws?.teamId ?? "loading"} /></main>
    </div>
  </div>;
}
