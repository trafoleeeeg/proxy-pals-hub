import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Pencil, Settings2, ShieldOff, UserPlus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/lib/useWorkspace";
import {
  listMembers,
  createInvite,
  revokeInvite,
  removeMember,
  listAudit,
  listMemberPermissions,
  setMemberPermissions,
  setMemberScope,
  createEmployee,
  updateEmployee,
  revokeEmployeeAccess,
  deleteEmployeeAccount,
} from "@/lib/team.functions";
import { PERMISSION_LABELS, PERMISSION_ORDER, EMPTY_PERMISSIONS, usePermissions, type PermissionKey } from "@/lib/usePermissions";
import { listFolderAccess, setFolderAccess, listFolders, createFolder, renameFolder, deleteFolder } from "@/lib/folders.functions";
import { listPresence } from "@/lib/presence.functions";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/app/team")({
  component: TeamPage,
});

export function TeamPage() {
  const workspace = useWorkspace();
  const ws = workspace.data;
  const { can } = usePermissions(ws?.teamId);
  const qc = useQueryClient();
  const members = useServerFn(listMembers);
  const invite = useServerFn(createInvite);
  const revoke = useServerFn(revokeInvite);
  const kick = useServerFn(removeMember);
  const audit = useServerFn(listAudit);
  const permissionsListFn = useServerFn(listMemberPermissions);
  const permissionsSaveFn = useServerFn(setMemberPermissions);
  const scopeFn = useServerFn(setMemberScope);
  const folderAccessListFn = useServerFn(listFolderAccess);
  const folderAccessFn = useServerFn(setFolderAccess);
  const foldersFn = useServerFn(listFolders);
  const createFolderFn = useServerFn(createFolder);
  const renameFolderFn = useServerFn(renameFolder);
  const deleteFolderFn = useServerFn(deleteFolder);
  const presenceFn = useServerFn(listPresence);
  const createEmployeeFn = useServerFn(createEmployee);
  const updateEmployeeFn = useServerFn(updateEmployee);
  const revokeEmployeeAccessFn = useServerFn(revokeEmployeeAccess);
  const deleteEmployeeAccountFn = useServerFn(deleteEmployeeAccount);
  const [newFolder, setNewFolder] = useState("");
  const [employee, setEmployee] = useState({ email: "", password: "", displayName: "" });
  const [email, setEmail] = useState("");
  const [removing, setRemoving] = useState<{ userId: string; email: string } | null>(null);
  const [editing, setEditing] = useState<{ userId: string; email: string; displayName: string; password: string } | null>(null);
  const [activeTab, setActiveTab] = useState("members");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRemoving(null); }, [ws?.teamId]);

  const isOwner = ws?.role === "owner";
  const canManage = !!ws?.canManage;
  const canManageFolders = can("folder.manage");

  const team = useQuery({
    queryKey: ["team", ws?.teamId],
    queryFn: () => members({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && isOwner,
  });

  const rights = useQuery({
    queryKey: ["member-permissions", ws?.teamId],
    queryFn: () => permissionsListFn({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && isOwner,
  });

  const folderAccess = useQuery({
    queryKey: ["folder-access", ws?.teamId],
    queryFn: () => folderAccessListFn({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && canManage,
  });

  const folderList = useQuery({
    queryKey: ["folders", ws?.teamId],
    queryFn: () => foldersFn({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && (canManage || canManageFolders),
  });

  const presence = useQuery({
    queryKey: ["presence", ws?.teamId],
    queryFn: () => presenceFn({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && canManage,
    refetchInterval: 30_000,
  });

  const log = useQuery({
    queryKey: ["audit", ws?.teamId],
    queryFn: () => audit({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && canManage,
  });

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ["team"] }), qc.invalidateQueries({ queryKey: ["audit"] }), qc.invalidateQueries({ queryKey: ["profiles"] }), qc.invalidateQueries({ queryKey: ["folder-access"] }), qc.invalidateQueries({ queryKey: ["folders"] }), qc.invalidateQueries({ queryKey: ["presence"] }), qc.invalidateQueries({ queryKey: ["member-permissions"] }), qc.invalidateQueries({ queryKey: ["permissions"] })]);
  };

  const inviteMut = useMutation({
    mutationFn: () => invite({ data: { teamId: ws!.teamId, email } }),
    onSuccess: async (row) => {
      const link = `${window.location.origin}/invite/${row.token}`;
      try { await navigator.clipboard.writeText(link); toast.success("Ссылка приглашения скопирована"); }
      catch { toast.success("Приглашение создано. Ссылка доступна в списке приглашений."); }
      setEmail("");
      refresh();
    },
    onError: () => toast.error("Не удалось создать приглашение. Проверьте почту и права владельца."),
  });

  const scopeMut = useMutation({
    mutationFn: (v: { userId: string; scope: "member" | "manager" }) =>
      scopeFn({ data: { teamId: ws!.teamId, userId: v.userId, scope: v.scope } }),
    onSuccess: async () => { toast.success("Уровень доступа изменён"); await refresh(); },
    onError: () => toast.error("Не удалось изменить уровень доступа. Это может сделать только владелец."),
  });

  const folderAccessMut = useMutation({
    mutationFn: (v: { folder: string; userId: string; granted: boolean }) =>
      folderAccessFn({ data: { teamId: ws!.teamId, folder: v.folder, userId: v.userId, granted: v.granted } }),
    onSuccess: refresh,
    onError: () => toast.error("Не удалось изменить доступ к папке. Обновите страницу и повторите попытку."),
  });

  const createFolderMut = useMutation({
    mutationFn: () => createFolderFn({ data: { teamId: ws!.teamId, name: newFolder.trim() } }),
    onSuccess: async () => { setNewFolder(""); toast.success("Папка создана"); await refresh(); },
    onError: (error: Error) => toast.error(error.message || "Не удалось создать папку"),
  });

  const renameFolderMut = useMutation({
    mutationFn: (v: { id: string; name: string }) => renameFolderFn({ data: { teamId: ws!.teamId, id: v.id, name: v.name } }),
    onSuccess: async () => { toast.success("Папка переименована"); await refresh(); },
    onError: (error: Error) => toast.error(error.message || "Не удалось переименовать папку"),
  });

  const deleteFolderMut = useMutation({
    mutationFn: (id: string) => deleteFolderFn({ data: { teamId: ws!.teamId, id } }),
    onSuccess: async () => { toast.success("Папка удалена, профили перенесены в основную"); await refresh(); },
    onError: (error: Error) => toast.error(error.message || "Не удалось удалить папку"),
  });

  // Короткий логин без «@» превращается в служебный адрес Umbra.
  const loginToEmail = (login: string) => {
    const value = login.trim();
    return value.includes("@") ? value.toLowerCase() : `${value.toLowerCase()}@umbra.app`;
  };

  const employeeMut = useMutation({
    mutationFn: () => createEmployeeFn({ data: {
      teamId: ws!.teamId,
      email: loginToEmail(employee.email),
      password: employee.password,
      ...(employee.displayName.trim() ? { displayName: employee.displayName.trim() } : {}),
    } }),
    onSuccess: async () => { setEmployee({ email: "", password: "", displayName: "" }); toast.success("Учётная запись сотрудника создана"); await refresh(); },
    onError: (error: Error) => toast.error(error.message || "Не удалось создать учётную запись"),
  });

  const updateEmployeeMut = useMutation({
    mutationFn: () => updateEmployeeFn({ data: {
      teamId: ws!.teamId,
      userId: editing!.userId,
      email: loginToEmail(editing!.email),
      displayName: editing!.displayName.trim(),
      ...(editing!.password ? { password: editing!.password } : {}),
    } }),
    onSuccess: async () => { setEditing(null); toast.success("Данные сотрудника изменены"); await refresh(); },
    onError: (error: Error) => toast.error(error.message || "Не удалось изменить учётную запись"),
  });

  const revokeAccessMut = useMutation({
    mutationFn: (userId: string) => revokeEmployeeAccessFn({ data: { teamId: ws!.teamId, userId } }),
    onSuccess: async () => { toast.success("Все доступы сотрудника отозваны"); await refresh(); },
    onError: (error: Error) => toast.error(error.message || "Не удалось забрать доступы"),
  });

  const rightsMut = useMutation({
    mutationFn: (v: { userId: string; permissions: Record<PermissionKey, boolean> }) =>
      permissionsSaveFn({ data: { teamId: ws!.teamId, userId: v.userId, permissions: v.permissions } }),
    onSuccess: refresh,
    onError: () => toast.error("Не удалось изменить права сотрудника. Обновите страницу и повторите попытку."),
  });

  async function removeSelectedMember() {
    if (!removing || !ws || busy) return;
    setBusy(true);
    try {
      if (ws.isSuperadmin) await deleteEmployeeAccountFn({ data: { teamId: ws.teamId, userId: removing.userId } });
      else await kick({ data: { teamId: ws.teamId, userId: removing.userId } });
      setRemoving(null); await refresh();
    }
    catch { toast.error("Не удалось удалить сотрудника. Проверьте подключение и права владельца."); }
    finally { setBusy(false); }
  }

  if (workspace.isPending) return <p role="status" className="text-sm text-muted-foreground">Загрузка команды…</p>;
  if (workspace.isError) return <p role="alert" className="text-sm text-destructive">Команда недоступна. <Button variant="outline" onClick={() => workspace.refetch()}>Повторить</Button></p>;

  if (!canManage && canManageFolders) {
    return <div className="max-w-3xl space-y-4">
      <div><h1 className="text-2xl font-semibold">Папки команды</h1><p className="mt-1 text-sm text-muted-foreground">Вы можете управлять папками. Доступ к профилям в них выдаётся владельцем отдельно.</p></div>
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Название новой папки" placeholder="Название новой папки" className="max-w-xs" value={newFolder} onChange={(event) => setNewFolder(event.target.value)} />
        <Button disabled={!newFolder.trim() || createFolderMut.isPending} onClick={() => createFolderMut.mutate()}>Создать папку</Button>
      </div>
      {folderList.isPending && <p role="status" className="text-sm">Загрузка папок…</p>}
      {folderList.isError && <p role="alert" className="text-sm text-destructive">Не удалось загрузить папки. <Button variant="outline" onClick={() => folderList.refetch()}>Повторить</Button></p>}
      <div className="rounded-lg border border-border bg-card">
        {(folderList.data ?? []).map((row) => <div key={row.id} className="flex items-center gap-2 border-b border-border p-3 last:border-0">
          <span className="min-w-0 flex-1 truncate text-sm">{row.name}{row.isDefault && <span className="ml-2 text-xs text-muted-foreground">основная</span>}</span>
          {!row.virtual && !row.isDefault && <>
            <Button size="sm" variant="ghost" disabled={renameFolderMut.isPending} onClick={() => { const name = window.prompt("Новое название папки", row.name)?.trim(); if (name && name !== row.name) renameFolderMut.mutate({ id: row.id, name }); }}>Переименовать</Button>
            <Button size="sm" variant="ghost" disabled={deleteFolderMut.isPending} onClick={() => { if (window.confirm(`Удалить папку «${row.name}»? Профили перейдут в основную.`)) deleteFolderMut.mutate(row.id); }}><Trash2 className="size-4" />Удалить</Button>
          </>}
        </div>)}
      </div>
    </div>;
  }

  if (!canManage) {
    return (
      <div className="py-8 text-sm text-muted-foreground">
        Управление командой доступно владельцу и администраторам.
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div>
        <h1 className="text-2xl font-semibold">Журнал действий</h1>
        <p className="mt-1 text-sm text-muted-foreground">Состав команды и приглашения меняет только владелец.</p>
        {log.isPending && <p role="status" className="py-3 text-sm">Загрузка журнала…</p>}
        <div className="mt-4 rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Когда</TableHead><TableHead>Кто</TableHead><TableHead>Действие</TableHead></TableRow></TableHeader>
            <TableBody>
              {(log.data ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="mono text-xs">{new Date(r.created_at).toLocaleString("ru-RU")}</TableCell>
                  <TableCell className="text-xs">{r.email ?? "—"}</TableCell>
                  <TableCell className="mono text-xs">{r.action}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    );
  }

  const rightsByUser = new Map((rights.data ?? []).map((row) => [row.userId, row]));
  const rightsOf = (userId: string): Record<PermissionKey, boolean> => {
    const row = rightsByUser.get(userId);
    return Object.fromEntries(PERMISSION_ORDER.map((key) => [key, row?.[key] === true])) as Record<PermissionKey, boolean>;
  };
  const staff = (team.data?.members ?? []).filter((m) => m.role === "member");
  const folderRows = folderList.data ?? [];
  const folders = folderRows.map((row) => row.name);
  const folderAccessSet = new Set((folderAccess.data ?? []).map((row) => `${row.folder}:${row.userId}`));

  return (
    <div>
      <h1 className="text-2xl font-semibold">Команда</h1>
      {team.isPending && <p role="status" className="mt-3 text-sm text-muted-foreground">Загрузка участников…</p>}
      {team.isError && <p role="alert" className="mt-3 text-sm text-destructive">Не удалось загрузить команду. <Button variant="outline" onClick={() => team.refetch()}>Повторить</Button></p>}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-6">
        <TabsList>
          <TabsTrigger value="members">Участники</TabsTrigger>
          <TabsTrigger value="rights">Права</TabsTrigger>
          <TabsTrigger value="folders">Папки</TabsTrigger>
          <TabsTrigger value="staff">Сотрудники</TabsTrigger>
          <TabsTrigger value="log">Журнал</TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="почта сотрудника"
              aria-label="Почта сотрудника"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="max-w-xs"
            />
            <Button onClick={() => inviteMut.mutate()} disabled={!email || inviteMut.isPending}>
              Пригласить
            </Button>
          </div>

          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Почта</TableHead>
                  <TableHead>Роль</TableHead>
                  <TableHead>Уровень доступа</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(team.data?.members ?? []).map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{m.email}</TableCell>
                    <TableCell>
                      <Badge variant={m.role === "owner" ? "default" : "outline"}>
                        {m.role === "owner" ? "владелец" : "сотрудник"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {m.role === "owner" ? (
                        <span className="text-xs text-muted-foreground">полный доступ</span>
                      ) : (
                        <Select value={m.scope} disabled={scopeMut.isPending} onValueChange={(v) => scopeMut.mutate({ userId: m.userId, scope: v as "member" | "manager" })}>
                          <SelectTrigger aria-label={`Уровень доступа ${m.email}`} className="h-8 w-44"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="member">только свои профили</SelectItem>
                            <SelectItem value="manager">администратор</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {m.role === "member" && (
                        <div className="flex justify-end gap-1">
                          {ws?.isSuperadmin && <Button variant="ghost" size="icon" title="Изменить сотрудника" aria-label={`Изменить ${m.email}`} onClick={() => setEditing({ userId: m.userId, email: m.email, displayName: m.name, password: "" })}><Pencil className="size-4" /></Button>}
                          <Button variant="ghost" size="icon" title="Забрать все доступы" aria-label={`Забрать все доступы у ${m.email}`} disabled={revokeAccessMut.isPending} onClick={() => revokeAccessMut.mutate(m.userId)}><ShieldOff className="size-4" /></Button>
                          <Button variant="ghost" size="icon" title="Удалить учётную запись" aria-label={`Удалить ${m.email}`} disabled={busy} onClick={() => setRemoving({ userId: m.userId, email: m.email })}><Trash2 className="size-4" /></Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {(team.data?.invites ?? []).length > 0 && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Ожидают принятия</h2>
              <ul className="space-y-2">
                {(team.data?.invites ?? []).map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="min-w-0 break-all">{i.email}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        try { await navigator.clipboard.writeText(`${window.location.origin}/invite/${i.token}`); toast.success("Ссылка скопирована"); }
                        catch { toast.error("Не удалось скопировать ссылку. Разрешите доступ к буферу обмена."); }
                      }}
                    >
                      Скопировать ссылку
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try { await revoke({ data: { inviteId: i.id } }); await refresh(); }
                        catch { toast.error("Не удалось отозвать приглашение."); }
                        finally { setBusy(false); }
                      }}
                    >
                      Отозвать
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </TabsContent>

        <TabsContent value="rights">
          <p className="mb-3 text-sm text-muted-foreground">Сотрудник работает только с профилями в открытых ему папках. Здесь вы решаете, что именно он может делать: по умолчанию — ничего, кроме запуска профилей.</p>
          {rights.isPending && <p role="status" className="py-3 text-sm">Загрузка прав…</p>}
          {rights.isError && <p role="alert" className="py-3 text-sm text-destructive">Не удалось загрузить права. <Button variant="outline" onClick={() => rights.refetch()}>Повторить</Button></p>}
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Сотрудник</TableHead>
                  {PERMISSION_ORDER.map((key) => (
                    <TableHead key={key} className="text-center text-xs">{PERMISSION_LABELS[key]}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {staff.map((m) => {
                  const current = rightsOf(m.userId);
                  const admin = m.scope === "manager";
                  return (
                    <TableRow key={m.userId}>
                      <TableCell className="font-medium">
                        {m.email}
                        {admin && <Badge variant="outline" className="ml-2">администратор</Badge>}
                      </TableCell>
                      {PERMISSION_ORDER.map((key) => (
                        <TableCell key={key} className="text-center">
                          <Checkbox
                            aria-label={`${PERMISSION_LABELS[key]} — ${m.email}`}
                            disabled={admin || rightsMut.isPending || rights.isError}
                            checked={admin || current[key]}
                            onCheckedChange={(v) => rightsMut.mutate({ userId: m.userId, permissions: { ...current, [key]: v === true } })}
                          />
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
                {!staff.length && (
                  <TableRow><TableCell className="py-8 text-sm text-muted-foreground">Сначала создайте учётные записи сотрудников</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {!!staff.length && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={rightsMut.isPending} onClick={() => staff.forEach((m) => { if (m.scope !== "manager") rightsMut.mutate({ userId: m.userId, permissions: { ...EMPTY_PERMISSIONS } }); })}>
                Снять все права
              </Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="folders">
          <p className="mb-3 text-sm text-muted-foreground">Основная папка есть всегда. Остальные папки вы создаёте сами, а доступ к папке открывает сотруднику все профили внутри неё, включая новые.</p>
          <div className="mb-4 flex flex-wrap gap-2">
            <Input
              placeholder="название новой папки"
              aria-label="Название новой папки"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              className="max-w-xs"
            />
            <Button onClick={() => createFolderMut.mutate()} disabled={!newFolder.trim() || createFolderMut.isPending}>Создать папку</Button>
          </div>
          <div className="mb-6 rounded-lg border border-border bg-card">
            <Table>
              <TableHeader><TableRow><TableHead>Папка</TableHead><TableHead className="text-right">Действия</TableHead></TableRow></TableHeader>
              <TableBody>
                {folderRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">
                      {row.name}
                      {row.isDefault && <Badge variant="outline" className="ml-2">основная</Badge>}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.virtual ? (
                        <span className="text-xs text-muted-foreground">папка из профилей</span>
                      ) : !row.isDefault && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={renameFolderMut.isPending}
                            onClick={() => {
                              const name = window.prompt("Новое название папки", row.name)?.trim();
                              if (name && name !== row.name) renameFolderMut.mutate({ id: row.id, name });
                            }}
                          >
                            Переименовать
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={deleteFolderMut.isPending}
                            onClick={() => { if (window.confirm(`Удалить папку «${row.name}»? Профили перейдут в основную.`)) deleteFolderMut.mutate(row.id); }}
                          >
                            <Trash2 className="size-4" /> Удалить
                          </Button>
                        </>
                      )}
                    </TableCell>

                  </TableRow>
                ))}
                {!folderRows.length && <TableRow><TableCell className="py-6 text-sm text-muted-foreground">Папок пока нет</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
          {folderAccess.isError && <p role="alert" className="py-3 text-sm text-destructive">Не удалось загрузить доступы к папкам. <Button variant="outline" onClick={() => folderAccess.refetch()}>Повторить</Button></p>}
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Папка</TableHead>
                  {staff.map((m) => <TableHead key={m.userId} className="text-center text-xs">{m.email}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {folders.map((name) => (
                  <TableRow key={name}>
                    <TableCell className="font-medium">{name}</TableCell>
                    {staff.map((m) => (
                      <TableCell key={m.userId} className="text-center">
                        <Checkbox
                          aria-label={`Доступ ${m.email} к папке ${name}`}
                          disabled={folderAccessMut.isPending || folderAccess.isError}
                          checked={folderAccessSet.has(`${name}:${m.userId}`)}
                          onCheckedChange={(v) => folderAccessMut.mutate({ folder: name, userId: m.userId, granted: v === true })}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {(!folders.length || !staff.length) && (
                  <TableRow><TableCell className="py-8 text-sm text-muted-foreground">{!staff.length ? "Сначала пригласите сотрудников" : "Пока нет папок с профилями"}</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="mt-6 space-y-3">
            <h2 className="text-sm font-semibold">Кому какие папки переданы</h2>
            {staff.map((m) => {
              const granted = folders.filter((name) => folderAccessSet.has(`${name}:${m.userId}`));
              return (
                <div key={m.userId} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{m.email}</span>
                    {granted.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={folderAccessMut.isPending}
                        onClick={() => granted.forEach((name) => folderAccessMut.mutate({ folder: name, userId: m.userId, granted: false }))}
                      >
                        Отозвать все папки
                      </Button>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {granted.length === 0 && <span className="text-xs text-muted-foreground">Папки не переданы</span>}
                    {granted.map((name) => (
                      <Badge key={name} variant="outline" className="gap-1 pr-1">
                        {name}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-5"
                          title={`Отозвать папку ${name}`}
                          aria-label={`Отозвать у ${m.email} папку ${name}`}
                          disabled={folderAccessMut.isPending}
                          onClick={() => folderAccessMut.mutate({ folder: name, userId: m.userId, granted: false })}
                        >
                          <X className="size-3" />
                        </Button>
                      </Badge>
                    ))}
                  </div>
                </div>
              );
            })}
            {!staff.length && <p className="text-sm text-muted-foreground">Сначала создайте учётные записи сотрудников</p>}
          </div>
        </TabsContent>


        <TabsContent value="staff" className="space-y-6">
          {ws?.isSuperadmin && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Создать учётную запись сотрудника</h2>
              <div className="flex flex-wrap gap-2">
                <Input className="max-w-xs" type="text" placeholder="логин или почта" aria-label="Логин или почта сотрудника для учётной записи" value={employee.email} onChange={(e) => setEmployee((v) => ({ ...v, email: e.target.value }))} />
                <Input className="max-w-xs" type="password" placeholder="надёжный пароль (от 12 символов)" aria-label="Пароль сотрудника" value={employee.password} onChange={(e) => setEmployee((v) => ({ ...v, password: e.target.value }))} />
                <Input className="max-w-xs" placeholder="имя (необязательно)" aria-label="Имя сотрудника" value={employee.displayName} onChange={(e) => setEmployee((v) => ({ ...v, displayName: e.target.value }))} />
                <Button onClick={() => employeeMut.mutate()} disabled={!employee.email.trim() || employee.password.length < 12 || employeeMut.isPending}>
                  <UserPlus className="size-4" /> Создать
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Используйте уникальный пароль от 12 символов с буквами, цифрами и знаками. Сотрудник сразу сможет войти с ним в Umbra.</p>
            </div>
          )}

          {presence.isError && <p role="alert" className="text-sm text-destructive">Не удалось загрузить активность. <Button variant="outline" onClick={() => presence.refetch()}>Повторить</Button></p>}
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader><TableRow><TableHead>Сотрудник</TableHead><TableHead>Статус</TableHead><TableHead>Последняя активность</TableHead><TableHead>Сейчас в профиле</TableHead><TableHead className="text-right">Управление</TableHead></TableRow></TableHeader>
              <TableBody>
                {(presence.data ?? []).map((row) => {
                  const seen = row.lastSeenAt ? new Date(row.lastSeenAt) : null;
                  const online = !!seen && Date.now() - seen.getTime() < 120_000;
                  return (
                    <TableRow key={row.userId}>
                      <TableCell>
                        <div className="font-medium">{row.name || row.email}</div>
                        {row.name && <div className="text-xs text-muted-foreground">{row.email}</div>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={online ? "default" : "outline"}>{online ? "в сети" : "не в сети"}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">{seen ? seen.toLocaleString("ru-RU") : "ещё не входил"}</TableCell>
                      <TableCell className="text-xs">{row.activeProfileId ? `занят: ${row.activeProfileName}` : "—"}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="icon" title="Настроить права" aria-label={`Настроить права ${row.email}`} onClick={() => setActiveTab("rights")}><Settings2 className="size-4" /></Button>
                          <Button variant="ghost" size="icon" title="Изменить сотрудника" aria-label={`Изменить ${row.email}`} onClick={() => setEditing({ userId: row.userId, email: row.email, displayName: row.name, password: "" })}><Pencil className="size-4" /></Button>
                          <Button variant="ghost" size="icon" title="Забрать все доступы" aria-label={`Забрать все доступы у ${row.email}`} disabled={revokeAccessMut.isPending} onClick={() => revokeAccessMut.mutate(row.userId)}><ShieldOff className="size-4" /></Button>
                          <Button variant="ghost" size="icon" title="Удалить учётную запись" aria-label={`Удалить ${row.email}`} disabled={busy} onClick={() => setRemoving({ userId: row.userId, email: row.email })}><Trash2 className="size-4" /></Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!(presence.data ?? []).length && <TableRow><TableCell className="py-6 text-sm text-muted-foreground">Сотрудников пока нет</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="log">
          {log.isPending && <p role="status" className="py-3 text-sm">Загрузка журнала…</p>}
          {log.isError && <p role="alert" className="py-3 text-sm text-destructive">Журнал недоступен. <Button variant="outline" onClick={() => log.refetch()}>Повторить</Button></p>}
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Когда</TableHead>
                  <TableHead>Кто</TableHead>
                  <TableHead>Действие</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(log.data ?? []).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="mono text-xs">
                      {new Date(r.created_at).toLocaleString("ru-RU")}
                    </TableCell>
                    <TableCell className="text-xs">{r.email ?? "—"}</TableCell>
                    <TableCell className="mono text-xs">{r.action}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>
      <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !updateEmployeeMut.isPending) setEditing(null); }}>
        <DialogContent className="w-[calc(100%-2rem)]">
          <DialogHeader><DialogTitle>Изменить сотрудника</DialogTitle><DialogDescription>Можно изменить логин, имя и установить новый пароль.</DialogDescription></DialogHeader>
          {editing && <div className="space-y-3">
            <Input aria-label="Новый логин или почта сотрудника" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
            <Input aria-label="Новое имя сотрудника" placeholder="Имя" value={editing.displayName} onChange={(e) => setEditing({ ...editing, displayName: e.target.value })} />
            <Input aria-label="Новый пароль сотрудника" type="password" placeholder="Новый пароль от 12 символов (необязательно)" value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
          </div>}
          <DialogFooter><Button variant="outline" disabled={updateEmployeeMut.isPending} onClick={() => setEditing(null)}>Отмена</Button><Button disabled={!editing?.email.trim() || (!!editing?.password && editing.password.length < 12) || updateEmployeeMut.isPending} onClick={() => updateEmployeeMut.mutate()}>{updateEmployeeMut.isPending ? "Сохранение…" : "Сохранить"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!removing} onOpenChange={(open) => { if (!open && !busy) setRemoving(null); }}><DialogContent role="alertdialog" className="w-[calc(100%-2rem)]"><DialogHeader><DialogTitle>Удалить учётную запись?</DialogTitle><DialogDescription className="break-words">{removing?.email} больше не сможет войти в Umbra. Это действие необратимо.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>Отмена</Button><Button variant="destructive" disabled={busy} onClick={removeSelectedMember}>{busy ? "Удаление…" : "Удалить учётную запись"}</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
