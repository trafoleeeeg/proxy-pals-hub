import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Pencil, Settings2, ShieldOff, UserPlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/lib/useWorkspace";
import {
  listMembers,
  createInvite,
  revokeInvite,
  removeMember,
  listMemberPermissions,
  setMemberPermissions,
  setMemberScope,
  createEmployee,
  updateEmployee,
  revokeEmployeeAccess,
  deleteEmployeeAccount,
} from "@/lib/team.functions";
import { PERMISSION_LABELS, PERMISSION_ORDER, EMPTY_PERMISSIONS, usePermissions, type PermissionKey } from "@/lib/usePermissions";
import { listPresence } from "@/lib/presence.functions";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  const permissionsListFn = useServerFn(listMemberPermissions);
  const permissionsSaveFn = useServerFn(setMemberPermissions);
  const scopeFn = useServerFn(setMemberScope);
  const presenceFn = useServerFn(listPresence);
  const createEmployeeFn = useServerFn(createEmployee);
  const updateEmployeeFn = useServerFn(updateEmployee);
  const revokeEmployeeAccessFn = useServerFn(revokeEmployeeAccess);
  const deleteEmployeeAccountFn = useServerFn(deleteEmployeeAccount);
  const [employee, setEmployee] = useState({ email: "", password: "", displayName: "" });
  const [email, setEmail] = useState("");
  const [removing, setRemoving] = useState<{ userId: string; email: string } | null>(null);
  const [editing, setEditing] = useState<{ userId: string; email: string; displayName: string; password: string } | null>(null);
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

  const presence = useQuery({
    queryKey: ["presence", ws?.teamId],
    queryFn: () => presenceFn({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && canManage,
    refetchInterval: 30_000,
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
    return <div className="space-y-3"><h1 className="text-2xl font-semibold">Команда</h1><p>Управление папками перенесено в отдельный раздел.</p><Button asChild><Link to="/app/folders">Открыть папки</Link></Button></div>;
  }

  if (!canManage) {
    return (
      <div className="py-8 text-sm text-muted-foreground">
        Управление командой доступно владельцу и администраторам.
      </div>
    );
  }

  if (!isOwner) {
    return <div className="space-y-3"><h1 className="text-2xl font-semibold">Команда</h1><p className="text-sm text-muted-foreground">Состав команды и приглашения меняет только владелец.</p><Button asChild variant="outline"><Link to="/app/audit">Открыть журнал</Link></Button></div>;
  }

  const rightsByUser = new Map((rights.data ?? []).map((row) => [row.userId, row]));
  const rightsOf = (userId: string): Record<PermissionKey, boolean> => {
    const row = rightsByUser.get(userId);
    return Object.fromEntries(PERMISSION_ORDER.map((key) => [key, row?.[key] === true])) as Record<PermissionKey, boolean>;
  };
  const staff = (team.data?.members ?? []).filter((m) => m.role === "member");

  return (
    <div>
      <h1 className="text-2xl font-semibold">Команда</h1>
      {team.isPending && <p role="status" className="mt-3 text-sm text-muted-foreground">Загрузка участников…</p>}
      {team.isError && <p role="alert" className="mt-3 text-sm text-destructive">Не удалось загрузить команду. <Button variant="outline" onClick={() => team.refetch()}>Повторить</Button></p>}

      <div className="mt-6 space-y-10">
        <section className="space-y-6"><h2 className="text-lg font-semibold">Участники</h2>
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
        </section>

        <section id="rights"><h2 className="mb-3 text-lg font-semibold">Права</h2>
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
        </section>



        <section className="space-y-6"><h2 className="text-lg font-semibold">Сотрудники</h2>
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
                          <Button variant="ghost" size="icon" title="Настроить права" aria-label={`Настроить права ${row.email}`} onClick={() => document.getElementById("rights")?.scrollIntoView({ behavior: "smooth" })}><Settings2 className="size-4" /></Button>
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
        </section>

      </div>
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
