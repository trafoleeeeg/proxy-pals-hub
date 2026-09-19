import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { UserPlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/lib/useWorkspace";
import {
  listMembers,
  createInvite,
  revokeInvite,
  removeMember,
  listAudit,
  setProfileAccess,
  setMemberScope,
} from "@/lib/team.functions";
import { listProfiles } from "@/lib/profiles.functions";
import { listFolderAccess, setFolderAccess } from "@/lib/folders.functions";
import { ProfileBulkDialog } from "@/components/profile-bulk";
import { toggleVisibleSelection } from "@/components/profile-model";
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
  const qc = useQueryClient();
  const members = useServerFn(listMembers);
  const invite = useServerFn(createInvite);
  const revoke = useServerFn(revokeInvite);
  const kick = useServerFn(removeMember);
  const audit = useServerFn(listAudit);
  const profilesFn = useServerFn(listProfiles);
  const accessFn = useServerFn(setProfileAccess);
  const scopeFn = useServerFn(setMemberScope);
  const folderAccessListFn = useServerFn(listFolderAccess);
  const folderAccessFn = useServerFn(setFolderAccess);
  const [email, setEmail] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkAccess, setBulkAccess] = useState<string[] | null>(null);
  const [removing, setRemoving] = useState<{ userId: string; email: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSelected([]); setBulkAccess(null); setRemoving(null); }, [ws?.teamId]);

  const isOwner = ws?.role === "owner";
  const canManage = !!ws?.canManage;

  const team = useQuery({
    queryKey: ["team", ws?.teamId],
    queryFn: () => members({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && isOwner,
  });

  const profiles = useQuery({
    queryKey: ["profiles", ws?.teamId],
    queryFn: () => profilesFn({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && isOwner,
  });

  const folderAccess = useQuery({
    queryKey: ["folder-access", ws?.teamId],
    queryFn: () => folderAccessListFn({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && canManage,
  });

  const log = useQuery({
    queryKey: ["audit", ws?.teamId],
    queryFn: () => audit({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && canManage,
  });

  useEffect(() => {
    const rows = profiles.data;
    if (rows) setSelected((current) => current.filter((id) => rows.some((profile) => profile.id === id)));
  }, [profiles.data]);

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ["team"] }), qc.invalidateQueries({ queryKey: ["audit"] }), qc.invalidateQueries({ queryKey: ["profiles"] }), qc.invalidateQueries({ queryKey: ["folder-access"] })]);
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

  const accessMut = useMutation({
    mutationFn: (v: { profileId: string; userId: string; granted: boolean }) =>
      accessFn({ data: v }),
    onSuccess: refresh,
    onError: () => toast.error("Не удалось изменить доступ. Обновите список и повторите попытку."),
  });

  async function removeSelectedMember() {
    if (!removing || !ws || busy) return;
    setBusy(true);
    try { await kick({ data: { teamId: ws.teamId, userId: removing.userId } }); setRemoving(null); await refresh(); }
    catch { toast.error("Не удалось удалить сотрудника. Проверьте подключение и права владельца."); }
    finally { setBusy(false); }
  }

  if (workspace.isPending) return <p role="status" className="text-sm text-muted-foreground">Загрузка команды…</p>;
  if (workspace.isError) return <p role="alert" className="text-sm text-destructive">Команда недоступна. <Button variant="outline" onClick={() => workspace.refetch()}>Повторить</Button></p>;

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

  const accessSet = new Set(
    (team.data?.access ?? []).map((a) => `${a.profile_id}:${a.user_id}`),
  );
  const staff = (team.data?.members ?? []).filter((m) => m.role === "member");
  const folders = [...new Set((profiles.data ?? []).map((p) => p.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  const folderAccessSet = new Set((folderAccess.data ?? []).map((row) => `${row.folder}:${row.userId}`));

  return (
    <div>
      <h1 className="text-2xl font-semibold">Команда</h1>
      {team.isPending && <p role="status" className="mt-3 text-sm text-muted-foreground">Загрузка участников…</p>}
      {team.isError && <p role="alert" className="mt-3 text-sm text-destructive">Не удалось загрузить команду. <Button variant="outline" onClick={() => team.refetch()}>Повторить</Button></p>}

      <Tabs defaultValue="members" className="mt-6">
        <TabsList>
          <TabsTrigger value="members">Участники</TabsTrigger>
          <TabsTrigger value="access">Доступы</TabsTrigger>
          <TabsTrigger value="folders">Папки</TabsTrigger>
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
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setRemoving({ userId: m.userId, email: m.email })}
                        >
                          <Trash2 className="size-4" /> Убрать
                        </Button>
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

        <TabsContent value="access">
          {profiles.isPending && <p role="status" className="py-3 text-sm">Загрузка профилей…</p>}
          {profiles.isError && <p role="alert" className="py-3 text-sm text-destructive">Не удалось загрузить профили. <Button variant="outline" onClick={() => profiles.refetch()}>Повторить</Button></p>}
          <div className="mb-3 flex flex-wrap items-center gap-3"><span className="text-sm text-muted-foreground">Выбрано: {selected.length}</span><Button variant="outline" disabled={!selected.length || team.isError || accessMut.isPending} onClick={() => setBulkAccess([...selected])}><UserPlus className="size-4" />Изменить доступ</Button></div>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10"><Checkbox aria-label="Выбрать все профили для доступа" checked={!selected.length ? false : selected.length === profiles.data?.length ? true : "indeterminate"} disabled={!profiles.data?.length} onCheckedChange={(v) => setSelected(v === true ? (profiles.data ?? []).map((p) => p.id) : [])} /></TableHead>
                  <TableHead>Профиль</TableHead>
                  {staff.map((m) => (
                    <TableHead key={m.userId} className="text-center text-xs">
                      {m.email}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(profiles.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell><Checkbox aria-label={`Выбрать ${p.name}`} checked={selected.includes(p.id)} onCheckedChange={(v) => setSelected((current) => toggleVisibleSelection(current, [p.id], v === true))} /></TableCell>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    {staff.map((m) => {
                      const granted = accessSet.has(`${p.id}:${m.userId}`);
                      return (
                        <TableCell key={m.userId} className="text-center">
                          <Checkbox
                            aria-label={`Доступ ${m.email} к ${p.name}`}
                            disabled={accessMut.isPending || team.isError || !!bulkAccess}
                            checked={granted}
                            onCheckedChange={(v) =>
                              accessMut.mutate({
                                profileId: p.id,
                                userId: m.userId,
                                granted: v === true,
                              })
                            }
                          />
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
                {staff.length === 0 && (
                  <TableRow>
                    <TableCell className="py-8 text-sm text-muted-foreground">
                      Сначала пригласите сотрудников
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="folders">
          <p className="mb-3 text-sm text-muted-foreground">Доступ к папке открывает сотруднику все профили внутри неё, включая новые.</p>
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
      {bulkAccess && ws && <ProfileBulkDialog action="access" ids={bulkAccess} teamId={ws.teamId} isOwner={isOwner} blocked={false} proxies={[]} onClose={() => setBulkAccess(null)} onSaved={() => { setSelected([]); void refresh(); }} />}
      <Dialog open={!!removing} onOpenChange={(open) => { if (!open && !busy) setRemoving(null); }}><DialogContent role="alertdialog" className="w-[calc(100%-2rem)]"><DialogHeader><DialogTitle>Удалить сотрудника?</DialogTitle><DialogDescription className="break-words">{removing?.email} потеряет доступ к профилям команды.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>Отмена</Button><Button variant="destructive" disabled={busy} onClick={removeSelectedMember}>{busy ? "Удаление…" : "Удалить сотрудника"}</Button></DialogFooter></DialogContent></Dialog>
    </div>
  );
}
