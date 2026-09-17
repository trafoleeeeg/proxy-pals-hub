import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Activity, CircleCheck, Copy, Cookie, FolderInput, Globe2, LockKeyhole, Pencil, Play, Plus, RefreshCw, Square, Trash2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/lib/useWorkspace";
import { listProfiles, saveProfile, cloneProfile, bulkCreateProfiles } from "@/lib/profiles.functions";
import { listProxies } from "@/lib/proxies.functions";
import { useDesktopProfileLifecycle } from "@/hooks/useDesktopProfileLifecycle";
import { generateFingerprint, describeFingerprint, type Fingerprint } from "@/lib/fingerprint";
import { ProfileFingerprint } from "@/components/profile-fingerprint";
import { ProfileCookies } from "@/components/profile-cookies";
import { ProfileBulkDialog, type BulkAction } from "@/components/profile-bulk";
import { ProfileProxyCell, useProxyOps } from "@/components/profile-proxy";
import { fingerprintError, profileFingerprintPayload, splitTags, toggleVisibleSelection } from "@/components/profile-model";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/app/")({ component: ProfilesPage });
type Edit = { id?: string; name: string; folder: string; tags: string; notes: string; proxyId: string; fingerprint: Fingerprint };
const ALL = "__all__";

export function ProfilesPage() {
  const { data: ws } = useWorkspace();
  return <ProfilesWorkspace key={ws?.teamId ?? "loading"} />;
}

function ProfilesWorkspace() {
  const workspace = useWorkspace();
  const ws = workspace.data;
  const owner = ws?.role === "owner";
  const qc = useQueryClient();
  const listFn = useServerFn(listProfiles);
  const saveFn = useServerFn(saveProfile);
  const cloneFn = useServerFn(cloneProfile);
  const createMany = useServerFn(bulkCreateProfiles);
  const proxiesFn = useServerFn(listProxies);
  const runtime = useDesktopProfileLifecycle();
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState(ALL);
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<{ mode: BulkAction; ids: string[] } | null>(null);
  const [cookiesId, setCookiesId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Edit | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState({ prefix: "Профиль", count: "10", folder: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const profiles = useQuery({ queryKey: ["profiles", ws?.teamId], queryFn: () => listFn({ data: { teamId: ws!.teamId } }), enabled: !!ws, refetchInterval: 20_000 });
  const proxies = useQuery({ queryKey: ["proxies", ws?.teamId], queryFn: () => proxiesFn({ data: { teamId: ws!.teamId } }), enabled: !!ws });
  const running = useMemo(() => new Set(runtime.running.map((p) => p.profileId)), [runtime.running]);
  const pending = useMemo(() => new Set([...runtime.pending, ...runtime.busy]), [runtime.pending, runtime.busy]);
  const locked = (id: string) => running.has(id) || pending.has(id) || !!profiles.data?.find((p) => p.id === id)?.lock;
  const folders = useMemo(() => [...new Set((profiles.data ?? []).map((p) => p.folder).filter(Boolean))].sort(), [profiles.data]);
  const rows = (profiles.data ?? []).filter((p) => (folder === ALL || p.folder === folder) && (p.name + " " + p.folder + " " + p.tags.join(" ")).toLowerCase().includes(search.toLowerCase()));
  const visibleIds = rows.map((p) => p.id);
  const visibleSelected = visibleIds.filter((id) => selected.includes(id)).length;
  const cookiesProfile = profiles.data?.find((p) => p.id === cookiesId);
  const overview = useMemo(() => {
    const all = profiles.data ?? [];
    const runningCount = all.filter((profile) => running.has(profile.id)).length;
    const lockedCount = all.filter((profile) => profile.lock && !running.has(profile.id)).length;
    const proxyCount = all.filter((profile) => !!profile.proxy_id).length;
    return [
      { label: "Всего профилей", value: all.length, hint: "в рабочем пространстве", icon: Activity, tone: "text-foreground" },
      { label: "Открыто сейчас", value: runningCount, hint: "на этом компьютере", icon: CircleCheck, tone: "text-primary" },
      { label: "Свободно", value: all.filter((profile) => !profile.lock && !running.has(profile.id) && !pending.has(profile.id)).length, hint: "можно запускать", icon: CircleCheck, tone: "text-success" },
      { label: "Занято", value: lockedCount, hint: "другим пользователем", icon: LockKeyhole, tone: "text-warning" },
      { label: "С прокси", value: proxyCount, hint: `${Math.max(0, all.length - proxyCount)} без прокси`, icon: Globe2, tone: "text-primary" },
    ];
  }, [profiles.data, running, pending]);
  useEffect(() => {
    if (!profiles.data) return;
    const ids = new Set(profiles.data.map((p) => p.id));
    setSelected((current) => current.filter((id) => ids.has(id)));
  }, [profiles.data]);

  function refresh() { void qc.invalidateQueries({ queryKey: ["profiles"] }); void qc.invalidateQueries({ queryKey: ["team"] }); }
  async function perform(key: string, operation: () => Promise<unknown>, onSuccess?: () => void) {
    if (busy) return;
    setBusy(key); setError(null);
    try { await operation(); onSuccess?.(); refresh(); }
    catch { setError("Операция не выполнена. Проверьте поля, права доступа, блокировки и подключение."); }
    finally { setBusy(null); }
  }
  function save() {
    if (!ws || !owner || !editing || !editing.name.trim() || fingerprintError(editing.fingerprint) || (editing.id && locked(editing.id))) return;
    void perform("save", () => saveFn({ data: { ...editing, teamId: ws.teamId, fingerprint: profileFingerprintPayload(editing.fingerprint), tags: splitTags(editing.tags), proxyId: editing.proxyId === "none" ? null : editing.proxyId } }), () => setEditing(null));
  }
  const count = Number(bulkForm.count);
  const validCount = Number.isInteger(count) && count >= 1 && count <= 200;
  function bulkCreate() {
    if (!ws || !owner || !validCount || !bulkForm.prefix.trim()) return;
    void perform("create", () => createMany({ data: { teamId: ws.teamId, prefix: bulkForm.prefix, count, folder: bulkForm.folder, fingerprints: Array.from({ length: count }, () => generateFingerprint()) } }), () => setBulkOpen(false));
  }
  function newProfile() { setError(null); setEditing({ name: "Профиль " + ((profiles.data?.length ?? 0) + 1), folder: folder === ALL ? "" : folder, tags: "", notes: "", proxyId: "none", fingerprint: generateFingerprint() }); }

  if (workspace.isPending) return <p role="status" className="text-sm text-muted-foreground">Загрузка рабочего пространства…</p>;
  if (workspace.isError) return <p role="alert" className="text-sm text-destructive">Не удалось загрузить команду. <Button variant="outline" onClick={() => workspace.refetch()}>Повторить</Button></p>;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-2xl font-semibold">Профили <span className="text-sm font-normal text-muted-foreground">{profiles.data?.length ?? 0}</span></h1>
      <div className="ml-auto flex flex-wrap gap-2">
        <Button size="icon" variant="outline" title="Обновить список" aria-label="Обновить список" disabled={profiles.isFetching} onClick={() => profiles.refetch()}><RefreshCw className={profiles.isFetching ? "size-4 animate-spin" : "size-4"} /></Button>
        {owner && <><Button variant="outline" disabled={!!busy} onClick={() => { setError(null); setBulkOpen(true); }}><Plus className="size-4" />Создать пачкой</Button><Button disabled={!!busy} onClick={newProfile}><Plus className="size-4" />Новый профиль</Button></>}
      </div>
    </div>
    <p className="text-xs text-muted-foreground">В облаке синхронизируются только cookies. Local Storage остаётся на этом компьютере.</p>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Показатели профилей">
      {overview.map((item) => { const Icon = item.icon; return <Card key={item.label} className="border-border/80 bg-card/70 shadow-none">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{item.label}</CardTitle><Icon className={`size-4 ${item.tone}`} /></CardHeader>
        <CardContent><p className={`text-2xl font-semibold tabular-nums ${item.tone}`}>{item.value}</p><p className="mt-1 text-xs text-muted-foreground">{item.hint}</p></CardContent>
      </Card>; })}
    </div>
    <div className="flex flex-wrap gap-2">
      <Input aria-label="Поиск профилей" placeholder="Поиск по названию, папке и меткам" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-48 flex-1" />
      <Select value={folder === ALL ? "all" : `folder:${folder}`} onValueChange={(value) => setFolder(value === "all" ? ALL : value.slice(7))}><SelectTrigger aria-label="Фильтр папки" className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Все папки</SelectItem><SelectItem value="folder:">Без папки</SelectItem>{folders.map((f) => <SelectItem key={f} value={`folder:${f}`}>{f}</SelectItem>)}</SelectContent></Select>
    </div>
    {selected.length > 0 && owner && <div className="flex flex-wrap items-center gap-2 border-y border-border bg-secondary/40 px-2 py-2">
      <span className="text-sm">Выбрано: {selected.length}{selected.length > visibleSelected ? " · скрыто фильтром: " + (selected.length - visibleSelected) : ""}</span>
      <Button variant="ghost" size="icon" title="Снять выбор" aria-label="Снять выбор" onClick={() => setSelected([])}><X className="size-4" /></Button>
      <Button variant="outline" size="sm" disabled={!!busy} onClick={() => setAction({ mode: "edit", ids: [...selected] })}><Pencil className="size-4" />Изменить</Button>
      <Button variant="outline" size="sm" disabled={!!busy} onClick={() => setAction({ mode: "move", ids: [...selected] })}><FolderInput className="size-4" />В папку</Button>
      <Button variant="outline" size="sm" disabled={!!busy} onClick={() => setAction({ mode: "access", ids: [...selected] })}><UserPlus className="size-4" />Доступ</Button>
      <Button variant="outline" size="icon" title="Удалить выбранные профили" aria-label="Удалить выбранные профили" disabled={!!busy} onClick={() => setAction({ mode: "delete", ids: [...selected] })}><Trash2 className="size-4 text-destructive" /></Button>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {profiles.isError && <p role="alert" className="text-sm text-destructive">Не удалось обновить профили. <Button size="sm" variant="outline" onClick={() => profiles.refetch()}>Повторить</Button></p>}
    {proxies.isError && <p role="alert" className="text-sm text-warning">Прокси недоступны. <Button size="sm" variant="outline" onClick={() => proxies.refetch()}>Повторить</Button></p>}
    <div className="overflow-x-auto border-y border-border">
      <Table className="min-w-[850px]"><TableHeader><TableRow>
        {owner && <TableHead className="w-10"><Checkbox aria-label="Выбрать видимые профили" disabled={!rows.length} checked={visibleSelected === 0 ? false : visibleSelected === rows.length ? true : "indeterminate"} onCheckedChange={(checked) => setSelected((current) => toggleVisibleSelection(current, visibleIds, checked === true))} /></TableHead>}
        <TableHead>Название</TableHead><TableHead>Папка</TableHead><TableHead>Прокси</TableHead><TableHead>Отпечаток</TableHead><TableHead>Состояние</TableHead><TableHead className="text-right">Действия</TableHead>
      </TableRow></TableHeader><TableBody>
        {profiles.isPending && <TableRow><TableCell colSpan={owner ? 7 : 6} className="py-8 text-center" role="status">Загрузка профилей…</TableCell></TableRow>}
        {rows.map((profile) => {
          const active = running.has(profile.id);
          const processing = runtime.busy.includes(profile.id);
          const proxy = proxies.data?.find((p) => p.id === profile.proxy_id);
          return <TableRow key={profile.id} data-state={selected.includes(profile.id) ? "selected" : undefined}>
            {owner && <TableCell><Checkbox aria-label={"Выбрать " + profile.name} checked={selected.includes(profile.id)} onCheckedChange={(v) => setSelected((current) => toggleVisibleSelection(current, [profile.id], v === true))} /></TableCell>}
            <TableCell className="max-w-60"><div className="break-words font-medium">{profile.name}</div><div className="mt-1 flex flex-wrap gap-1">{profile.tags.map((tag) => <Badge key={tag} variant="outline" className="max-w-40 break-all text-[10px]">{tag}</Badge>)}</div></TableCell>
            <TableCell className="max-w-36 break-words text-xs text-muted-foreground">{profile.folder || "Без папки"}</TableCell>
            <TableCell className="max-w-36 break-words text-xs">{profile.proxy_id ? (proxy?.label ?? "Недоступен") : "Без прокси"}</TableCell>
            <TableCell className="max-w-48 text-xs text-muted-foreground">{describeFingerprint(profile.fingerprint)}</TableCell>
            <TableCell><Badge variant="outline" className={active ? "text-primary" : profile.lock || pending.has(profile.id) ? "text-warning" : "text-success"}>{processing ? "выполняется" : active ? "открыт у вас" : runtime.pending.includes(profile.id) ? "синхронизация" : profile.lock ? "занят" : "свободен"}</Badge></TableCell>
            <TableCell><div className="flex items-center justify-end gap-1">
              <Button variant={active ? "outline" : "default"} size="icon" title={active ? "Закрыть профиль" : runtime.available ? "Запустить профиль" : "Запуск в приложении Windows"} aria-label={(active ? "Закрыть " : "Запустить ") + profile.name} disabled={!runtime.available || !runtime.ready || runtime.restoring || processing || (!active && locked(profile.id))} onClick={() => { void (active ? runtime.stop(profile.id) : runtime.start(profile.id)).catch((e: Error) => toast.error(e.message)); }}>{processing ? <RefreshCw className="size-4 animate-spin" /> : active ? <Square className="size-4" /> : <Play className="size-4" />}</Button>
              {owner && <>
                <Button variant="ghost" size="icon" title="Изменить профиль" aria-label={"Изменить " + profile.name} disabled={!!busy || locked(profile.id)} onClick={() => { setError(null); setEditing({ id: profile.id, name: profile.name, folder: profile.folder, tags: profile.tags.join(", "), notes: profile.notes, proxyId: profile.proxy_id ?? "none", fingerprint: profile.fingerprint }); }}><Pencil className="size-4" /></Button>
                <Button variant="ghost" size="icon" title="Создать копию" aria-label={"Копия " + profile.name} disabled={!!busy} onClick={() => perform(profile.id, () => cloneFn({ data: { id: profile.id } }))}><Copy className="size-4" /></Button>
                <Button variant="ghost" size="icon" title="Cookies" aria-label={"Cookies " + profile.name} disabled={!!busy} onClick={() => setCookiesId(profile.id)}><Cookie className="size-4" /></Button>
                <Button variant="ghost" size="icon" title="Удалить профиль" aria-label={"Удалить " + profile.name} disabled={!!busy || locked(profile.id)} onClick={() => setAction({ mode: "delete", ids: [profile.id] })}><Trash2 className="size-4 text-destructive" /></Button>
              </>}
            </div></TableCell>
          </TableRow>;
        })}
        {!profiles.isPending && !profiles.isError && !rows.length && <TableRow><TableCell colSpan={owner ? 7 : 6} className="py-10 text-center text-sm text-muted-foreground">{search || folder !== ALL ? "По выбранным фильтрам профилей нет" : "Профилей пока нет"}</TableCell></TableRow>}
      </TableBody></Table>
    </div>

    {action && ws && <ProfileBulkDialog action={action.mode} ids={action.ids} teamId={ws.teamId} isOwner={owner} blocked={action.ids.some(locked)} proxies={proxies.data ?? []} onClose={() => setAction(null)} onSaved={() => { setSelected([]); refresh(); }} />}
    {cookiesProfile && <ProfileCookies profileId={cookiesProfile.id} name={cookiesProfile.name} isOwner={owner} locked={locked(cookiesProfile.id)} onClose={() => setCookiesId(null)} onSaved={refresh} />}
    <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}><DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{editing?.id ? "Изменить профиль" : "Новый профиль"}</DialogTitle><DialogDescription>Настройки профиля Windows</DialogDescription></DialogHeader>
      {editing && <fieldset disabled={!!busy} className="space-y-3">
        <Label className="grid gap-2">Название<Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Label>
        <div className="grid gap-3 sm:grid-cols-2"><Label className="grid gap-2">Папка<Input value={editing.folder} onChange={(e) => setEditing({ ...editing, folder: e.target.value })} /></Label><Label className="grid gap-2">Метки через запятую<Input value={editing.tags} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} /></Label></div>
        <div className="space-y-2"><Label>Прокси</Label><Select disabled={!!busy || proxies.isPending || proxies.isError} value={editing.proxyId} onValueChange={(proxyId) => setEditing({ ...editing, proxyId })}><SelectTrigger aria-label="Прокси профиля"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Без прокси</SelectItem>{(proxies.data ?? []).map((proxy) => <SelectItem key={proxy.id} value={proxy.id}>{proxy.label} · {proxy.host}:{proxy.port}</SelectItem>)}</SelectContent></Select></div>
        <Label className="grid gap-2">Заметки<Textarea rows={2} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Label>
        <ProfileFingerprint value={editing.fingerprint} onChange={(fingerprint) => setEditing({ ...editing, fingerprint })} disabled={!!busy} country={proxies.data?.find((p) => p.id === editing.proxyId)?.country} />
      </fieldset>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setEditing(null)}>Отмена</Button><Button disabled={!owner || !!busy || !editing?.name.trim() || !!(editing && fingerprintError(editing.fingerprint)) || !!(editing?.id && locked(editing.id))} onClick={save}>{busy === "save" ? "Сохранение…" : "Сохранить"}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={bulkOpen} onOpenChange={(open) => { if (!busy) setBulkOpen(open); }}><DialogContent className="w-[calc(100%-2rem)]"><DialogHeader><DialogTitle>Создать несколько профилей</DialogTitle><DialogDescription>У каждого профиля будет отдельный отпечаток.</DialogDescription></DialogHeader>
      <fieldset disabled={!!busy} className="space-y-3"><Label className="grid gap-2">Название-основа<Input value={bulkForm.prefix} onChange={(e) => setBulkForm({ ...bulkForm, prefix: e.target.value })} /></Label><Label className="grid gap-2">Количество, 1–200<Input type="number" min={1} max={200} step={1} value={bulkForm.count} onChange={(e) => setBulkForm({ ...bulkForm, count: e.target.value })} /></Label><Label className="grid gap-2">Папка<Input value={bulkForm.folder} onChange={(e) => setBulkForm({ ...bulkForm, folder: e.target.value })} /></Label></fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setBulkOpen(false)}>Отмена</Button><Button disabled={!owner || !!busy || !validCount || !bulkForm.prefix.trim()} onClick={bulkCreate}>{busy === "create" ? "Создание…" : "Создать"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
