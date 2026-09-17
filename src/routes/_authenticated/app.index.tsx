import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Archive, BriefcaseBusiness, CheckCircle2, CircleUserRound, Copy, Cookie, Folder, FolderInput, FolderOpen, Globe2, LockKeyhole, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, RefreshCw, Search, Settings2, ShoppingBag, Square, Trash2, UserPlus, UsersRound, X } from "lucide-react";
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
import { ColumnSettings, InlineText, MetadataManager, type FixedColumn } from "@/components/profile-table-tools";
import { createProfileField, createProfileStatus, listProfileMetadata } from "@/lib/profile-metadata.functions";
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

export const Route = createFileRoute("/_authenticated/app/")({
  head: () => ({ meta: [
    { title: "Профили — Umbra" },
    { name: "description", content: "Управление профилями, прокси, статусами и рабочими полями команды Umbra." },
    { property: "og:title", content: "Профили — Umbra" },
    { property: "og:description", content: "Профили, прокси, статусы и рабочие поля команды Umbra." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: ProfilesPage,
});
type Edit = { id?: string; name: string; folder: string; tags: string; notes: string; proxyId: string; fingerprint: Fingerprint; statusId: string | null; customFields: Record<string, string> };
const ALL = "__all__";
const DEFAULT_COLUMNS: FixedColumn[] = ["folder", "status", "proxy", "tags", "notes", "fingerprint", "updated"];
const dateTime = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
const statusTone: Record<string, string> = { primary: "border-primary/40 bg-primary/10 text-primary", success: "border-success/40 bg-success/10 text-success", warning: "border-warning/40 bg-warning/10 text-warning", destructive: "border-destructive/40 bg-destructive/10 text-destructive", muted: "border-border bg-muted text-muted-foreground" };

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
  const metadataFn = useServerFn(listProfileMetadata);
  const addStatusFn = useServerFn(createProfileStatus);
  const addFieldFn = useServerFn(createProfileField);
  const runtime = useDesktopProfileLifecycle();
  const proxyOps = useProxyOps(ws?.teamId);
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
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [foldersCollapsed, setFoldersCollapsed] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<FixedColumn[]>(DEFAULT_COLUMNS);
  const [visibleFields, setVisibleFields] = useState<string[]>([]);
  const profiles = useQuery({ queryKey: ["profiles", ws?.teamId], queryFn: () => { if (!ws) throw new Error("Команда не загружена"); return listFn({ data: { teamId: ws.teamId } }); }, enabled: !!ws, refetchInterval: 20_000 });
  const proxies = useQuery({ queryKey: ["proxies", ws?.teamId], queryFn: () => { if (!ws) throw new Error("Команда не загружена"); return proxiesFn({ data: { teamId: ws.teamId } }); }, enabled: !!ws });
  const metadata = useQuery({ queryKey: ["profile-metadata", ws?.teamId], queryFn: () => { if (!ws) throw new Error("Команда не загружена"); return metadataFn({ data: { teamId: ws.teamId } }); }, enabled: !!ws });
  const running = useMemo(() => new Set(runtime.running.map((p) => p.profileId)), [runtime.running]);
  const pending = useMemo(() => new Set([...runtime.pending, ...runtime.busy]), [runtime.pending, runtime.busy]);
  const locked = (id: string) => running.has(id) || pending.has(id) || !!profiles.data?.find((p) => p.id === id)?.lock;
  const folders = useMemo(() => [...new Set((profiles.data ?? []).map((p) => p.folder).filter(Boolean))].sort(), [profiles.data]);
  const rows = (profiles.data ?? []).filter((p) => (folder === ALL || p.folder === folder) && (p.name + " " + p.folder + " " + p.tags.join(" ")).toLowerCase().includes(search.toLowerCase()));
  const visibleIds = rows.map((p) => p.id);
  const visibleSelected = visibleIds.filter((id) => selected.includes(id)).length;
  const cookiesProfile = profiles.data?.find((p) => p.id === cookiesId);
  useEffect(() => {
    if (!profiles.data) return;
    const ids = new Set(profiles.data.map((p) => p.id));
    setSelected((current) => current.filter((id) => ids.has(id)));
  }, [profiles.data]);
  useEffect(() => {
    if (!metadata.data) return;
    setVisibleFields((current) => current.length ? current.filter((id) => metadata.data.fields.some((field) => field.id === id)) : metadata.data.fields.map((field) => field.id));
  }, [metadata.data]);

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
  function newProfile() { setError(null); setEditing({ name: "Профиль " + ((profiles.data?.length ?? 0) + 1), folder: folder === ALL ? "" : folder, tags: "", notes: "", proxyId: "none", fingerprint: generateFingerprint(), statusId: null, customFields: {} }); }
  function patchProfile(profile: NonNullable<typeof profiles.data>[number], changes: Partial<Pick<Edit, "name" | "folder" | "notes" | "statusId" | "customFields">> & { tags?: string[] }) {
    if (!ws || !owner || locked(profile.id)) return;
    void perform("inline-" + profile.id, () => saveFn({ data: {
      id: profile.id, teamId: ws.teamId, name: changes.name ?? profile.name, folder: changes.folder ?? profile.folder,
      tags: changes.tags ?? profile.tags, notes: changes.notes ?? profile.notes, proxyId: profile.proxy_id, fingerprint: profile.fingerprint,
      statusId: changes.statusId === undefined ? profile.status_id : changes.statusId,
      customFields: changes.customFields ?? profile.custom_fields,
    } }));
  }
  const shown = (key: FixedColumn) => visibleColumns.includes(key);
  const shownFields = (metadata.data?.fields ?? []).filter((field) => visibleFields.includes(field.id));
  const columnCount = 3 + visibleColumns.length + shownFields.length + (owner && editMode ? 1 : 0);
  const occupied = (profiles.data ?? []).filter((profile) => !!profile.lock && !running.has(profile.id)).length;
  const available = Math.max(0, (profiles.data?.length ?? 0) - running.size - occupied);
  const withProxy = (profiles.data ?? []).filter((profile) => !!profile.proxy_id).length;
  const folderIcons = [Folder, BriefcaseBusiness, ShoppingBag, UsersRound, Globe2];

  if (workspace.isPending) return <p role="status" className="text-sm text-muted-foreground">Загрузка рабочего пространства…</p>;
  if (workspace.isError) return <p role="alert" className="text-sm text-destructive">Не удалось загрузить команду. <Button variant="outline" onClick={() => workspace.refetch()}>Повторить</Button></p>;

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
      <div><h1 className="text-xl font-semibold">Профили</h1><p className="text-xs text-muted-foreground">{profiles.data?.length ?? 0} профилей · {running.size} открыто</p></div>
      <div className="ml-auto flex flex-wrap gap-2">
        {owner && <Button variant={editMode ? "secondary" : "outline"} onClick={() => setEditMode((value) => !value)}><Pencil className="size-4" />{editMode ? "Готово" : "Редактировать"}</Button>}
        {owner && editMode && <Button size="icon" variant="outline" title="Настроить поля" aria-label="Настроить поля" onClick={() => setMetadataOpen(true)}><Settings2 /></Button>}
        {editMode && <ColumnSettings visible={visibleColumns} onChange={setVisibleColumns} fields={metadata.data?.fields ?? []} visibleFields={visibleFields} onFieldChange={setVisibleFields} />}
        <Button size="icon" variant="outline" title="Обновить список" aria-label="Обновить список" disabled={profiles.isFetching} onClick={() => profiles.refetch()}><RefreshCw className={profiles.isFetching ? "size-4 animate-spin" : "size-4"} /></Button>
        {owner && <><Button variant="outline" disabled={!!busy} onClick={() => { setError(null); setBulkOpen(true); }}><Plus className="size-4" />Создать пачкой</Button><Button disabled={!!busy} onClick={newProfile}><Plus className="size-4" />Новый профиль</Button></>}
      </div>
    </div>
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
      {[
        { label: "Всего", value: profiles.data?.length ?? 0, detail: "профилей", icon: CircleUserRound, tone: "text-foreground" },
        { label: "Открыто", value: running.size, detail: "на этом компьютере", icon: Play, tone: "text-primary" },
        { label: "Свободно", value: available, detail: "можно запускать", icon: CheckCircle2, tone: "text-success" },
        { label: "Занято", value: occupied, detail: "другим пользователем", icon: LockKeyhole, tone: "text-warning" },
        { label: "С прокси", value: withProxy, detail: `${(profiles.data?.length ?? 0) - withProxy} без прокси`, icon: Globe2, tone: "text-primary" },
      ].map((stat) => <div key={stat.label} className="flex min-h-20 items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
        <stat.icon className={`size-4 shrink-0 ${stat.tone}`} />
        <div className="min-w-0"><p className="truncate text-xs text-muted-foreground">{stat.label}</p><p className={`text-xl font-semibold leading-6 ${stat.tone}`}>{stat.value}</p><p className="truncate text-[11px] text-muted-foreground">{stat.detail}</p></div>
      </div>)}
    </div>
    <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Поиск профилей" placeholder="Поиск по профилям" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" /></div>
    {selected.length > 0 && owner && editMode && <div className="flex flex-wrap items-center gap-2 border-y border-border bg-secondary/40 px-2 py-2">
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
    <div className={`grid min-h-[480px] grid-cols-1 overflow-hidden border-y border-border ${foldersCollapsed ? "md:grid-cols-[52px_minmax(0,1fr)]" : "md:grid-cols-[184px_minmax(0,1fr)]"}`}>
      <aside className="border-b border-border bg-sidebar p-2 md:border-b-0 md:border-r">
        <div className={`mb-1 flex items-center ${foldersCollapsed ? "justify-center" : "justify-between"}`}>
          {!foldersCollapsed && <p className="px-2 py-2 text-[11px] font-semibold uppercase text-sidebar-foreground">Папки</p>}
          <Button variant="ghost" size="icon" className="size-8" title={foldersCollapsed ? "Показать папки" : "Скрыть названия папок"} aria-label={foldersCollapsed ? "Показать папки" : "Скрыть названия папок"} onClick={() => setFoldersCollapsed((value) => !value)}>{foldersCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}</Button>
        </div>
        <Button variant={folder === ALL ? "secondary" : "ghost"} title="Все профили" aria-label="Все профили" className={`h-9 w-full px-2 text-xs ${foldersCollapsed ? "justify-center" : "justify-start"}`} onClick={() => setFolder(ALL)}><FolderOpen className="size-4 shrink-0 text-primary" />{!foldersCollapsed && <><span className="truncate">Все профили</span><span className="ml-auto tabular-nums text-muted-foreground">{profiles.data?.length ?? 0}</span></>}</Button>
        <Button variant={folder === "" ? "secondary" : "ghost"} title="Без папки" aria-label="Без папки" className={`h-9 w-full px-2 text-xs ${foldersCollapsed ? "justify-center" : "justify-start"}`} onClick={() => setFolder("")}><Archive className="size-4 shrink-0 text-warning" />{!foldersCollapsed && <><span className="truncate">Без папки</span><span className="ml-auto tabular-nums text-muted-foreground">{(profiles.data ?? []).filter((profile) => !profile.folder).length}</span></>}</Button>
        {folders.map((item, index) => { const FolderIcon = folderIcons[index % folderIcons.length] ?? Folder; return <Button key={item} variant={folder === item ? "secondary" : "ghost"} title={item} aria-label={`Папка ${item}`} className={`h-9 w-full px-2 text-xs ${foldersCollapsed ? "justify-center" : "justify-start"}`} onClick={() => setFolder(item)}><FolderIcon className={`size-4 shrink-0 ${folder === item ? "text-primary" : "text-muted-foreground"}`} />{!foldersCollapsed && <><span className="truncate">{item}</span><span className="ml-auto tabular-nums text-muted-foreground">{(profiles.data ?? []).filter((profile) => profile.folder === item).length}</span></>}</Button>; })}
      </aside>
      <div className="min-w-0 overflow-x-auto"><Table className="min-w-max text-xs"><TableHeader className="sticky top-0 z-10 bg-background"><TableRow>
        {owner && editMode && <TableHead className="w-10"><Checkbox aria-label="Выбрать видимые профили" disabled={!rows.length} checked={visibleSelected === 0 ? false : visibleSelected === rows.length ? true : "indeterminate"} onCheckedChange={(checked) => setSelected((current) => toggleVisibleSelection(current, visibleIds, checked === true))} /></TableHead>}
        <TableHead className="w-12">Запуск</TableHead><TableHead className="min-w-36">Название</TableHead>{shown("folder") && <TableHead className="max-w-28">Папка</TableHead>}{shown("status") && <TableHead className="max-w-32">Статус</TableHead>}{shown("proxy") && <TableHead className="min-w-52">Прокси</TableHead>}{shown("tags") && <TableHead className="max-w-36">Метки</TableHead>}{shown("notes") && <TableHead className="max-w-40">Заметки</TableHead>}{shownFields.map((field) => <TableHead className="max-w-36" key={field.id}>{field.name}</TableHead>)}{shown("fingerprint") && <TableHead className="max-w-40">Отпечаток</TableHead>}{shown("updated") && <TableHead>Изменён</TableHead>}{shown("created") && <TableHead>Создан</TableHead>}{owner && editMode && <TableHead className="sticky right-0 bg-background text-right">Редактирование</TableHead>}
      </TableRow></TableHeader><TableBody>
        {profiles.isPending && <TableRow><TableCell colSpan={columnCount} className="py-8 text-center" role="status">Загрузка профилей…</TableCell></TableRow>}
        {rows.map((profile) => {
          const active = running.has(profile.id);
          const processing = runtime.busy.includes(profile.id);
          const proxy = proxies.data?.find((p) => p.id === profile.proxy_id);
          return <TableRow key={profile.id} data-state={selected.includes(profile.id) ? "selected" : undefined}>
            {owner && editMode && <TableCell><Checkbox aria-label={"Выбрать " + profile.name} checked={selected.includes(profile.id)} onCheckedChange={(v) => setSelected((current) => toggleVisibleSelection(current, [profile.id], v === true))} /></TableCell>}
            <TableCell><Button variant={active ? "outline" : "default"} size="icon" title={active ? "Закрыть профиль" : runtime.available ? "Запустить профиль" : "Запуск в приложении Windows"} aria-label={(active ? "Закрыть " : "Запустить ") + profile.name} disabled={!runtime.available || !runtime.ready || runtime.restoring || processing || (!active && locked(profile.id))} onClick={() => { void (active ? runtime.stop(profile.id) : runtime.start(profile.id)).catch((e: Error) => toast.error(e.message)); }}>{processing ? <RefreshCw className="size-4 animate-spin" /> : active ? <Square className="size-4" /> : <Play className="size-4" />}</Button></TableCell>
            <TableCell className="max-w-36">{editMode ? <InlineText value={profile.name} placeholder="Название" disabled={!owner || !!busy || locked(profile.id)} onSave={(name) => patchProfile(profile, { name })} /> : <span className="block truncate font-medium" title={profile.name}>{profile.name}</span>}</TableCell>
            {shown("folder") && <TableCell className="max-w-28">{editMode ? <InlineText value={profile.folder} placeholder="Без папки" disabled={!owner || !!busy || locked(profile.id)} onSave={(value) => patchProfile(profile, { folder: value })} /> : <span className="block truncate text-muted-foreground" title={profile.folder || "Без папки"}>{profile.folder || "—"}</span>}</TableCell>}
            {shown("status") && <TableCell className="max-w-32">{editMode ? <Select disabled={!owner || !!busy || locked(profile.id)} value={profile.status_id ?? "none"} onValueChange={(value) => patchProfile(profile, { statusId: value === "none" ? null : value })}><SelectTrigger className="h-7 w-28 border-transparent px-2 text-xs shadow-none"><SelectValue placeholder="Без статуса" /></SelectTrigger><SelectContent><SelectItem value="none">Без статуса</SelectItem>{(metadata.data?.statuses ?? []).map((status) => <SelectItem key={status.id} value={status.id}><span className={`rounded border px-1.5 py-0.5 ${statusTone[status.color] ?? statusTone["muted"]}`}>{status.name}</span></SelectItem>)}</SelectContent></Select> : (() => { const status = metadata.data?.statuses.find((item) => item.id === profile.status_id); return status ? <span className={`inline-flex max-w-28 truncate rounded border px-1.5 py-0.5 ${statusTone[status.color] ?? statusTone["muted"]}`}>{status.name}</span> : <span className="text-muted-foreground">—</span>; })()}</TableCell>}
            {shown("proxy") && <TableCell className="max-w-56 text-xs">{profile.proxy_id && !proxy ? <span className="text-warning">Прокси недоступен</span> : <ProfileProxyCell proxy={proxy} ops={proxyOps} compact />}</TableCell>}
            {shown("tags") && <TableCell className="max-w-36">{editMode ? <InlineText value={profile.tags.join(", ")} placeholder="Добавить метки" disabled={!owner || !!busy || locked(profile.id)} onSave={(value) => patchProfile(profile, { tags: splitTags(value) })} /> : <span className="block truncate text-muted-foreground" title={profile.tags.join(", ")}>{profile.tags.join(", ") || "—"}</span>}</TableCell>}
            {shown("notes") && <TableCell className="max-w-40">{editMode ? <InlineText value={profile.notes} placeholder="Добавить заметку" multiline disabled={!owner || !!busy || locked(profile.id)} onSave={(notes) => patchProfile(profile, { notes })} /> : <span className="block truncate text-muted-foreground" title={profile.notes}>{profile.notes || "—"}</span>}</TableCell>}
            {shownFields.map((field) => <TableCell className="max-w-36" key={field.id}>{editMode ? <InlineText value={profile.custom_fields[field.id] ?? ""} placeholder={field.name} disabled={!owner || !!busy || locked(profile.id)} onSave={(value) => patchProfile(profile, { customFields: { ...profile.custom_fields, [field.id]: value } })} /> : <span className="block truncate text-muted-foreground" title={profile.custom_fields[field.id] ?? ""}>{profile.custom_fields[field.id] || "—"}</span>}</TableCell>)}
            {shown("fingerprint") && <TableCell className="max-w-40"><span className="block truncate text-muted-foreground" title={describeFingerprint(profile.fingerprint)}>{describeFingerprint(profile.fingerprint)}</span></TableCell>}
            {shown("updated") && <TableCell className="whitespace-nowrap text-muted-foreground">{dateTime(profile.updated_at)}</TableCell>}
            {shown("created") && <TableCell className="whitespace-nowrap text-muted-foreground">{dateTime(profile.created_at)}</TableCell>}
            {owner && editMode && <TableCell className="sticky right-0 bg-background"><div className="flex items-center justify-end gap-1">
                <Button variant="ghost" size="icon" title="Изменить профиль" aria-label={"Изменить " + profile.name} disabled={!!busy || locked(profile.id)} onClick={() => { setError(null); setEditing({ id: profile.id, name: profile.name, folder: profile.folder, tags: profile.tags.join(", "), notes: profile.notes, proxyId: profile.proxy_id ?? "none", fingerprint: profile.fingerprint, statusId: profile.status_id, customFields: profile.custom_fields }); }}><Pencil className="size-4" /></Button>
                <Button variant="ghost" size="icon" title="Создать копию" aria-label={"Копия " + profile.name} disabled={!!busy} onClick={() => perform(profile.id, () => cloneFn({ data: { id: profile.id } }))}><Copy className="size-4" /></Button>
                <Button variant="ghost" size="icon" title="Cookies" aria-label={"Cookies " + profile.name} disabled={!!busy} onClick={() => setCookiesId(profile.id)}><Cookie className="size-4" /></Button>
                <Button variant="ghost" size="icon" title="Удалить профиль" aria-label={"Удалить " + profile.name} disabled={!!busy || locked(profile.id)} onClick={() => setAction({ mode: "delete", ids: [profile.id] })}><Trash2 className="size-4 text-destructive" /></Button>
            </div></TableCell>}
          </TableRow>;
        })}
        {!profiles.isPending && !profiles.isError && !rows.length && <TableRow><TableCell colSpan={columnCount} className="py-10 text-center text-sm text-muted-foreground">{search || folder !== ALL ? "По выбранным фильтрам профилей нет" : "Профилей пока нет"}</TableCell></TableRow>}
      </TableBody></Table>
      </div>
    </div>

    {action && ws && <ProfileBulkDialog action={action.mode} ids={action.ids} teamId={ws.teamId} isOwner={owner} blocked={action.ids.some(locked)} proxies={proxies.data ?? []} onClose={() => setAction(null)} onSaved={() => { setSelected([]); refresh(); }} />}
    {cookiesProfile && <ProfileCookies profileId={cookiesProfile.id} name={cookiesProfile.name} isOwner={owner} locked={locked(cookiesProfile.id)} onClose={() => setCookiesId(null)} onSaved={refresh} />}
    {ws && <MetadataManager open={metadataOpen} onClose={() => setMetadataOpen(false)} statuses={metadata.data?.statuses ?? []} fields={metadata.data?.fields ?? []} busy={!!busy} onAddStatus={async (name, color) => { await perform("metadata", () => addStatusFn({ data: { teamId: ws.teamId, name, color: color as "primary" | "success" | "warning" | "destructive" | "muted" } }), () => void qc.invalidateQueries({ queryKey: ["profile-metadata"] })); }} onAddField={async (name, fieldType) => { await perform("metadata", () => addFieldFn({ data: { teamId: ws.teamId, name, fieldType: fieldType as "text" | "number" | "date" | "url" } }), () => void qc.invalidateQueries({ queryKey: ["profile-metadata"] })); }} />}
    <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}><DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{editing?.id ? "Изменить профиль" : "Новый профиль"}</DialogTitle><DialogDescription>Настройки профиля Windows</DialogDescription></DialogHeader>
      {editing && <fieldset disabled={!!busy} className="space-y-3">
        <Label className="grid gap-2">Название<Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Label>
        <div className="grid gap-3 sm:grid-cols-2"><Label className="grid gap-2">Папка<Input value={editing.folder} onChange={(e) => setEditing({ ...editing, folder: e.target.value })} /></Label><Label className="grid gap-2">Метки через запятую<Input value={editing.tags} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} /></Label></div>
        <div className="space-y-2"><Label>Прокси</Label><Select disabled={!!busy || proxies.isPending || proxies.isError} value={editing.proxyId} onValueChange={(proxyId) => setEditing({ ...editing, proxyId })}><SelectTrigger aria-label="Прокси профиля"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Без прокси</SelectItem>{(proxies.data ?? []).map((proxy) => <SelectItem key={proxy.id} value={proxy.id}>{proxy.label} · {proxy.host}:{proxy.port}</SelectItem>)}</SelectContent></Select></div>
        <Label className="grid gap-2">Заметки<Textarea rows={2} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Label>
        <div className="space-y-2"><Label>Статус</Label><Select value={editing.statusId ?? "none"} onValueChange={(value) => setEditing({ ...editing, statusId: value === "none" ? null : value })}><SelectTrigger><SelectValue placeholder="Без статуса" /></SelectTrigger><SelectContent><SelectItem value="none">Без статуса</SelectItem>{(metadata.data?.statuses ?? []).map((status) => <SelectItem key={status.id} value={status.id}>{status.name}</SelectItem>)}</SelectContent></Select></div>
        {(metadata.data?.fields ?? []).map((field) => <Label key={field.id} className="grid gap-2">{field.name}<Input type={field.field_type === "number" ? "number" : field.field_type === "date" ? "date" : field.field_type === "url" ? "url" : "text"} value={editing.customFields[field.id] ?? ""} onChange={(event) => setEditing({ ...editing, customFields: { ...editing.customFields, [field.id]: event.target.value } })} /></Label>)}
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
