import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Globe2, MoreVertical, CircleUserRound, Copy, Cookie, FolderInput, LockKeyhole, Pencil, Play, Plus, RefreshCw, Search, Settings2, Square, Tag, Trash2, X } from "lucide-react";

const statusColor: Record<string, string> = {
  primary: "text-primary", success: "text-success", warning: "text-warning",
  destructive: "text-destructive", muted: "text-muted-foreground",
};
import { toast } from "sonner";
import { useWorkspace } from "@/lib/useWorkspace";
import { parseCookieImport } from "@/lib/server-cookies";
import { MAIN_FOLDER, useProfileFolder } from "@/lib/useProfileFolder";
import { listProfiles, saveProfile, cloneProfile, bulkCreateProfiles, getProfileCookieStatus } from "@/lib/profiles.functions";
import { listProxies } from "@/lib/proxies.functions";
import { listFolders } from "@/lib/folders.functions";
import { usePermissions } from "@/lib/usePermissions";
import { useDesktopProfileLifecycle } from "@/hooks/useDesktopProfileLifecycle";
import { generateFingerprint, describeFingerprint, type Fingerprint, type FingerprintOS } from "@/lib/fingerprint";
import { ProfileFingerprint } from "@/components/profile-fingerprint";
import { ProfileCookies } from "@/components/profile-cookies";
import { ProfileDragHandle, ProfileDragRow } from "@/components/profile-dnd";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ProfileBulkDialog, type BulkAction } from "@/components/profile-bulk";
import { ProfileProxyCell, useProxyOps } from "@/components/profile-proxy";
import { ColumnSettings, InlineText, MetadataManager, NotesCell, ResizableHead, StatusCell, useColumnWidths, type FixedColumn } from "@/components/profile-table-tools";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { createProfileField, createProfileStatus, deleteProfileStatus, listProfileMetadata, updateProfileStatus } from "@/lib/profile-metadata.functions";
import { fingerprintError, profileFingerprintPayload, splitTags, toggleVisibleSelection } from "@/components/profile-model";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
type Edit = { id?: string; name: string; folder: string; tags: string; notes: string; proxyId: string; fingerprint: Fingerprint; statusId: string | null; customFields: Record<string, string>; cookies?: string };
const MAX_COOKIE_IMPORT_BYTES = 5_000_000;
const DEFAULT_COLUMNS: FixedColumn[] = ["folder", "status", "proxy", "notes", "fingerprint", "updated", "created"];
const dateTime = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));

export function ProfilesPage() {
  const { data: ws } = useWorkspace();
  return <ProfilesWorkspace key={ws?.teamId ?? "loading"} />;
}

function ProfilesWorkspace() {
  const workspace = useWorkspace();
  const ws = workspace.data;
  const owner = ws?.role === "owner";
  const { can, isError: permissionsError } = usePermissions(ws?.teamId);
  const canEdit = can("profile.edit");
  const canCreate = can("profile.create");
  const canDelete = can("profile.delete");
  const manage = canEdit || canCreate || canDelete;
  const qc = useQueryClient();
  const listFn = useServerFn(listProfiles);
  const saveFn = useServerFn(saveProfile);
  const cloneFn = useServerFn(cloneProfile);
  const createMany = useServerFn(bulkCreateProfiles);
  const cookieStatusFn = useServerFn(getProfileCookieStatus);
  const proxiesFn = useServerFn(listProxies);
  const metadataFn = useServerFn(listProfileMetadata);
  const addStatusFn = useServerFn(createProfileStatus);
  const addFieldFn = useServerFn(createProfileField);
  const updateStatusFn = useServerFn(updateProfileStatus);
  const deleteStatusFn = useServerFn(deleteProfileStatus);
  const runtime = useDesktopProfileLifecycle();
  const proxyOps = useProxyOps(ws?.teamId);
  const foldersFn = useServerFn(listFolders);
  const folderList = useQuery({ queryKey: ["folders", ws?.teamId], queryFn: () => { if (!ws) throw new Error("Команда не загружена"); return foldersFn({ data: { teamId: ws.teamId } }); }, enabled: !!ws });
  const [search, setSearch] = useState("");
  const { folder, setFolder } = useProfileFolder();
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<{ mode: BulkAction; ids: string[] } | null>(null);
  const [cookiesId, setCookiesId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Edit | null>(null);
  const cookieStatus = useQuery({ queryKey: ["profile-cookie-status", editing?.id], queryFn: () => cookieStatusFn({ data: { profileId: editing!.id! } }), enabled: !!editing?.id && owner });
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState({ prefix: "Профиль", count: "10", folder: MAIN_FOLDER, os: "windows" as FingerprintOS, aggressivePrivacyMode: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const { widths, setWidth, reset: resetWidths } = useColumnWidths();
  const [visibleColumns, setVisibleColumns] = useState<FixedColumn[]>(DEFAULT_COLUMNS);
  const [visibleFields, setVisibleFields] = useState<string[]>([]);
  const profiles = useQuery({ queryKey: ["profiles", ws?.teamId], queryFn: () => { if (!ws) throw new Error("Команда не загружена"); return listFn({ data: { teamId: ws.teamId } }); }, enabled: !!ws, refetchInterval: 20_000 });
  // Пока идёт смена IP, опрашиваем прокси каждые 5 секунд — иначе плашка
  // «меняем IP…» зависает на устаревших данных после завершения смены.
  const proxies = useQuery({ queryKey: ["proxies", ws?.teamId], queryFn: () => { if (!ws) throw new Error("Команда не загружена"); return proxiesFn({ data: { teamId: ws.teamId } }); }, enabled: !!ws, refetchInterval: (query) => query.state.data?.some((proxy) => proxy.rotationStatus === "changing") ? 5000 : false });
  const metadata = useQuery({ queryKey: ["profile-metadata", ws?.teamId], queryFn: () => { if (!ws) throw new Error("Команда не загружена"); return metadataFn({ data: { teamId: ws.teamId } }); }, enabled: !!ws });
  const running = useMemo(() => new Set(runtime.running.map((p) => p.profileId)), [runtime.running]);
  const pending = useMemo(() => new Set([...runtime.pending, ...runtime.busy]), [runtime.pending, runtime.busy]);
  const locked = (id: string) => running.has(id) || pending.has(id) || !!profiles.data?.find((p) => p.id === id)?.lock;
  useEffect(() => {
    if (ws?.scope !== "owner" && folder === MAIN_FOLDER && folderList.data?.length) setFolder(folderList.data[0]!.name);
  }, [ws?.scope, folder, folderList.data, setFolder]);
  useEffect(() => {
    if (ws?.scope !== "owner" && bulkForm.folder === MAIN_FOLDER && folderList.data?.length)
      setBulkForm((value) => ({ ...value, folder: folderList.data![0]!.name }));
  }, [ws?.scope, bulkForm.folder, folderList.data]);
  const rows = (profiles.data ?? []).filter((p) => (p.folder === folder || (folder === MAIN_FOLDER && !p.folder)) && (p.name + " " + p.folder + " " + p.tags.join(" ")).toLowerCase().includes(search.toLowerCase()));
  const folderNames = (folderList.data ?? []).map((row) => row.name);
  const visibleIds = rows.map((p) => p.id);
  const visibleSelected = visibleIds.filter((id) => selected.includes(id)).length;
  const cookiesProfile = profiles.data?.find((p) => p.id === cookiesId);
  const editingCookiesBytes = new Blob([editing?.cookies ?? ""]).size;
  const cookiePreview = useMemo(() => {
    if (!editing?.cookies?.trim() || editingCookiesBytes > MAX_COOKIE_IMPORT_BYTES) return null;
    try {
      const cookies = parseCookieImport(editing.cookies);
      return { count: cookies.length, expired: cookies.filter((cookie) => cookie.expirationDate != null && cookie.expirationDate <= Date.now() / 1000).length, error: false };
    } catch { return { count: 0, expired: 0, error: true }; }
  }, [editing?.cookies, editingCookiesBytes]);
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
  async function perform<T>(key: string, operation: () => Promise<T>, onSuccess?: (result: T) => void) {
    if (busy) return;
    setBusy(key); setError(null);
    try { const result = await operation(); onSuccess?.(result); refresh(); }
    catch { setError("Операция не выполнена. Проверьте поля, права доступа, блокировки и подключение."); }
    finally { setBusy(null); }
  }
  function save() {
    if (!ws || !(editing?.id ? canEdit : canCreate) || !editing || !editing.name.trim() || editingCookiesBytes > MAX_COOKIE_IMPORT_BYTES || cookiePreview?.error || (cookiePreview && cookiePreview.count === cookiePreview.expired) || fingerprintError(editing.fingerprint) || (editing.id && locked(editing.id))) return;
    const { cookies, ...profile } = editing;
    void perform("save", () => saveFn({ data: {
      ...profile, teamId: ws.teamId, fingerprint: profileFingerprintPayload(editing.fingerprint), tags: splitTags(editing.tags),
      proxyId: editing.proxyId === "none" ? null : editing.proxyId,
      ...(!editing.id && cookies?.trim() ? { cookies } : {}),
    } }), (result) => {
      setEditing(null);
      if (!editing.id && result.importedCookies) toast.success(`Профиль создан · cookies сохранены: ${result.importedCookies}. Они будут установлены при первом запуске.`);
    });
  }
  const count = Number(bulkForm.count);
  const validCount = Number.isInteger(count) && count >= 1 && count <= 200;
  function bulkCreate() {
    if (!ws || !canCreate || !validCount || !bulkForm.prefix.trim()) return;
    void perform("create", () => createMany({ data: { teamId: ws.teamId, prefix: bulkForm.prefix, count, folder: bulkForm.folder, fingerprints: Array.from({ length: count }, () => ({ ...generateFingerprint(null, bulkForm.os), aggressivePrivacyMode: bulkForm.aggressivePrivacyMode })) } }), () => setBulkOpen(false));
  }
  function newProfile() { setError(null); setEditing({ name: "Профиль " + ((profiles.data?.length ?? 0) + 1), folder, tags: "", notes: "", proxyId: "none", fingerprint: generateFingerprint(), statusId: null, customFields: {}, cookies: "" }); }
  function patchProfile(profile: NonNullable<typeof profiles.data>[number], changes: Partial<Pick<Edit, "name" | "folder" | "notes" | "statusId" | "customFields">> & { tags?: string[] }) {
    if (!ws || !canEdit || locked(profile.id)) return;
    void perform("inline-" + profile.id, () => saveFn({ data: {
      id: profile.id, teamId: ws.teamId, name: changes.name ?? profile.name, folder: changes.folder ?? profile.folder,
      tags: changes.tags ?? profile.tags, notes: changes.notes ?? profile.notes, proxyId: profile.proxy_id, fingerprint: profile.fingerprint,
      statusId: changes.statusId === undefined ? profile.status_id : changes.statusId,
      customFields: changes.customFields ?? profile.custom_fields,
    } }));
  }
  async function createStatus(name: string, color: string) {
    if (!ws || !canEdit) return;
    await perform("metadata", () => addStatusFn({ data: { teamId: ws.teamId, name, color: color as "primary" | "success" | "warning" | "destructive" | "muted" } }), () => void qc.invalidateQueries({ queryKey: ["profile-metadata"] }));
  }
  const shown = (key: FixedColumn) => visibleColumns.includes(key);
  const cellStyle = (key: string) => (widths[key] ? { width: widths[key], minWidth: widths[key], maxWidth: widths[key] } : undefined);
  const shownFields = (metadata.data?.fields ?? []).filter((field) => visibleFields.includes(field.id));
  const columnCount = 2 + visibleColumns.length + shownFields.length + (manage ? 2 : 0);
  const occupied = (profiles.data ?? []).filter((profile) => !!profile.lock && !running.has(profile.id)).length;
  
  const withProxy = (profiles.data ?? []).filter((profile) => !!profile.proxy_id).length;

  if (workspace.isPending) return <p role="status" className="text-sm text-muted-foreground">Загрузка рабочего пространства…</p>;
  if (workspace.isError) return <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive"><span>Не удалось загрузить рабочее пространство.</span><Button variant="outline" disabled={workspace.isFetching} onClick={() => workspace.refetch()}><RefreshCw className={workspace.isFetching ? "size-4 animate-spin" : "size-4"} />{workspace.isFetching ? "Подключение…" : "Повторить"}</Button></div>;

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
      <div><h1 className="text-xl font-semibold">Профили</h1><p className="text-xs text-muted-foreground">{profiles.data?.length ?? 0} профилей · {running.size} открыто</p></div>
      <div className="ml-auto flex flex-wrap gap-2">
        {canEdit && <Button variant={editMode ? "secondary" : "outline"} onClick={() => setEditMode((value) => !value)}><Pencil className="size-4" />{editMode ? "Готово" : "Редактировать"}</Button>}
        {canEdit && <Button variant="outline" title="Статусы и поля" aria-label="Статусы и поля" onClick={() => setMetadataOpen(true)}><Settings2 className="size-4" />Статусы и поля</Button>}
        {editMode && <Button variant="outline" size="sm" onClick={resetWidths}>Ширина колонок по умолчанию</Button>}
        {editMode && <ColumnSettings visible={visibleColumns} onChange={setVisibleColumns} fields={metadata.data?.fields ?? []} visibleFields={visibleFields} onFieldChange={setVisibleFields} />}
        <Button size="icon" variant="outline" title="Обновить список" aria-label="Обновить список" disabled={profiles.isFetching} onClick={() => profiles.refetch()}><RefreshCw className={profiles.isFetching ? "size-4 animate-spin" : "size-4"} /></Button>
        {canCreate && <><Button variant="outline" disabled={!!busy} onClick={() => { setError(null); setBulkForm((current) => ({ ...current, aggressivePrivacyMode: false })); setBulkOpen(true); }}><Plus className="size-4" />Создать пачкой</Button><Button disabled={!!busy} onClick={newProfile}><Plus className="size-4" />Новый профиль</Button></>}
      </div>
    </div>
    <div className="flex w-full flex-wrap gap-2">
      {[
        { label: "Всего", value: profiles.data?.length ?? 0, detail: "профилей", icon: CircleUserRound, tone: "text-foreground" },
        ...(metadata.data?.statuses ?? []).map((status) => ({
          label: status.name,
          value: (profiles.data ?? []).filter((profile) => profile.status_id === status.id).length,
          detail: "профилей со статусом",
          icon: Tag,
          tone: statusColor[status.color] ?? "text-foreground",
        })),
        { label: "Занято", value: occupied, detail: "другим пользователем", icon: LockKeyhole, tone: "text-warning" },
        { label: "С прокси", value: withProxy, detail: `${(profiles.data?.length ?? 0) - withProxy} без прокси`, icon: Globe2, tone: "text-primary" },
      ].map((stat) => <div key={stat.label} title={stat.detail} className="flex min-w-32 flex-1 items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
        <stat.icon className={`size-4 shrink-0 ${stat.tone}`} />
        <p className="min-w-0 truncate text-xs text-muted-foreground">{stat.label}</p>
        <p className={`ml-auto text-lg font-semibold leading-5 tabular-nums ${stat.tone}`}>{stat.value}</p>
      </div>)}
    </div>
    <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Поиск профилей" placeholder="Поиск по профилям" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" /></div>
    {selected.length > 0 && manage && <div className="flex flex-wrap items-center gap-2 border-y border-border bg-secondary/40 px-2 py-2">
      <span className="text-sm">Выбрано: {selected.length}{selected.length > visibleSelected ? " · скрыто фильтром: " + (selected.length - visibleSelected) : ""}</span>
      <Button variant="ghost" size="icon" title="Снять выбор" aria-label="Снять выбор" onClick={() => setSelected([])}><X className="size-4" /></Button>
      <Button variant="outline" size="sm" disabled={!!busy} onClick={() => setAction({ mode: "edit", ids: [...selected] })}><Pencil className="size-4" />Изменить</Button>
      <Button variant="outline" size="sm" disabled={!!busy} onClick={() => setAction({ mode: "move", ids: [...selected] })}><FolderInput className="size-4" />В папку</Button>
      <Button variant="outline" size="icon" title="Удалить выбранные профили" aria-label="Удалить выбранные профили" disabled={!!busy} onClick={() => setAction({ mode: "delete", ids: [...selected] })}><Trash2 className="size-4 text-destructive" /></Button>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {permissionsError && <p role="alert" className="text-sm text-destructive">Не удалось загрузить ваши права. Обновите страницу и повторите попытку.</p>}
    {ws?.scope === "member" && folderList.isSuccess && !folderList.data.length && <p role="status" className="text-sm text-warning">Вам пока не открыта ни одна папка с профилями. Владелец может выдать доступ в разделе «Папки».</p>}
    {profiles.isError && <p role="alert" className="text-sm text-destructive">Не удалось обновить профили. <Button size="sm" variant="outline" onClick={() => profiles.refetch()}>Повторить</Button></p>}
    {proxies.isError && <p role="alert" className="text-sm text-warning">Прокси недоступны. <Button size="sm" variant="outline" onClick={() => proxies.refetch()}>Повторить</Button></p>}
    <div className="min-h-[480px] overflow-hidden border-y border-border">
      <div className="scroll-thin min-w-0 overflow-x-auto"><Table className="min-w-max table-fixed text-xs"><TableHeader className="sticky top-0 z-10 bg-background"><TableRow>
        {manage && <TableHead className="w-10"><Checkbox aria-label="Выбрать видимые профили" disabled={!rows.length} checked={visibleSelected === 0 ? false : visibleSelected === rows.length ? true : "indeterminate"} onCheckedChange={(checked) => setSelected((current) => toggleVisibleSelection(current, visibleIds, checked === true))} /></TableHead>}
        <TableHead className="w-12">Запуск</TableHead>{manage && <TableHead className="w-10"><span className="sr-only">Действия</span></TableHead>}<ResizableHead columnKey="name" widths={widths} setWidth={setWidth} className="min-w-28">Название</ResizableHead>{shown("folder") && <ResizableHead columnKey="folder" widths={widths} setWidth={setWidth} className="min-w-24">Папка</ResizableHead>}{shown("status") && <ResizableHead columnKey="status" widths={widths} setWidth={setWidth} className="min-w-24">Статус</ResizableHead>}{shown("proxy") && <ResizableHead columnKey="proxy" widths={widths} setWidth={setWidth} className="min-w-56">Прокси</ResizableHead>}{shown("notes") && <ResizableHead columnKey="notes" widths={widths} setWidth={setWidth} className="min-w-32">Заметки</ResizableHead>}{shownFields.map((field) => <ResizableHead columnKey={"field-" + field.id} widths={widths} setWidth={setWidth} className="min-w-24" key={field.id}>{field.name}</ResizableHead>)}{shown("fingerprint") && <ResizableHead columnKey="fingerprint" widths={widths} setWidth={setWidth} className="min-w-32">Отпечаток</ResizableHead>}{shown("updated") && <ResizableHead columnKey="updated" widths={widths} setWidth={setWidth} className="min-w-28">Изменён</ResizableHead>}{shown("created") && <ResizableHead columnKey="created" widths={widths} setWidth={setWidth} className="min-w-28">Создан</ResizableHead>}
      </TableRow></TableHeader><TableBody>
        {profiles.isPending && <TableRow><TableCell colSpan={columnCount} className="py-8 text-center" role="status">Загрузка профилей…</TableCell></TableRow>}
        <SortableContext items={rows.map((profile) => `profile:${profile.id}`)} strategy={verticalListSortingStrategy}>
        {rows.map((profile) => {
          const active = running.has(profile.id);
          const processing = runtime.busy.includes(profile.id);
          const proxy = proxies.data?.find((p) => p.id === profile.proxy_id);
          const busyBy = !active && profile.lock ? (profile.lock.name || profile.lock.email || "другой сотрудник") : null;
          return <ContextMenu key={profile.id}><ContextMenuTrigger asChild><ProfileDragRow id={profile.id} name={profile.name} disabled={!canEdit || !!busy} data-state={selected.includes(profile.id) ? "selected" : undefined}>
            {manage && <TableCell><Checkbox aria-label={"Выбрать " + profile.name} checked={selected.includes(profile.id)} onCheckedChange={(v) => setSelected((current) => toggleVisibleSelection(current, [profile.id], v === true))} /></TableCell>}
            <TableCell><Button variant={active ? "outline" : "default"} size="icon" title={active ? "Закрыть профиль" : busyBy ? `Профиль занят: ${busyBy}` : runtime.available ? "Запустить профиль" : "Запуск в приложении Windows"} aria-label={busyBy ? `Профиль ${profile.name} занят: ${busyBy}` : (active ? "Закрыть " : "Запустить ") + profile.name} disabled={!runtime.available || !runtime.ready || runtime.restoring || processing || (!active && locked(profile.id))} onClick={() => { void (active ? runtime.stop(profile.id) : runtime.start(profile.id)).catch((e: Error) => toast.error(e.message)); }}>{processing ? <RefreshCw className="size-4 animate-spin" /> : active ? <Square className="size-4" /> : busyBy ? <LockKeyhole className="size-4" /> : <Play className="size-4" />}</Button></TableCell>
            {manage && <TableCell><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7" title="Действия с профилем" aria-label={"Действия " + profile.name}><MoreVertical className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="start" className="w-44">
              <DropdownMenuItem disabled={!canEdit || !!busy || locked(profile.id)} onSelect={() => { setError(null); setEditing({ id: profile.id, name: profile.name, folder: profile.folder, tags: profile.tags.join(", "), notes: profile.notes, proxyId: profile.proxy_id ?? "none", fingerprint: profile.fingerprint, statusId: profile.status_id, customFields: profile.custom_fields }); }}><Pencil className="size-4" />Изменить</DropdownMenuItem>
              <DropdownMenuItem disabled={!canCreate || !!busy} onSelect={() => void perform(profile.id, () => cloneFn({ data: { id: profile.id } }))}><Copy className="size-4" />Создать копию</DropdownMenuItem>
              <DropdownMenuItem disabled={!!busy} onSelect={() => setCookiesId(profile.id)}><Cookie className="size-4" />Cookies</DropdownMenuItem>
              <DropdownMenuItem disabled={!canDelete || !!busy || locked(profile.id)} onSelect={() => setAction({ mode: "delete", ids: [profile.id] })}><Trash2 className="size-4 text-destructive" />Удалить</DropdownMenuItem>
            </DropdownMenuContent></DropdownMenu></TableCell>}
            <TableCell style={cellStyle("name")} className="max-w-36"><div className="flex items-center">{canEdit && <ProfileDragHandle />}{editMode ? <InlineText value={profile.name} placeholder="Название" disabled={!canEdit || !!busy || locked(profile.id)} onSave={(name) => patchProfile(profile, { name })} /> : <span className="block truncate font-medium" title={busyBy ? `${profile.name} — занят: ${busyBy}` : profile.name}>{profile.name}{busyBy && <span className="ml-1 text-[11px] font-normal text-warning">занят</span>}</span>}</div></TableCell>
            {shown("folder") && <TableCell style={cellStyle("folder")} className="max-w-28"><span className="block truncate text-muted-foreground" title={profile.folder || MAIN_FOLDER}>{profile.folder || MAIN_FOLDER}</span></TableCell>}
                        {shown("status") && <TableCell style={cellStyle("status")} className="max-w-32"><StatusCell statusId={profile.status_id} statuses={metadata.data?.statuses ?? []} disabled={!canEdit || !!busy || locked(profile.id)} canCreate={!!canEdit} onSelect={(statusId) => patchProfile(profile, { statusId })} onCreate={createStatus} /></TableCell>}
            {shown("proxy") && <TableCell style={cellStyle("proxy")} className="text-xs">{profile.proxy_id && !proxy ? <span className="text-warning">Прокси недоступен</span> : <ProfileProxyCell proxy={proxy} ops={proxyOps} compact />}</TableCell>}
            {shown("notes") && <TableCell style={cellStyle("notes")} className="max-w-40"><NotesCell value={profile.notes} disabled={!canEdit || !!busy || locked(profile.id)} onSave={(notes) => patchProfile(profile, { notes })} /></TableCell>}
            {shownFields.map((field) => <TableCell style={cellStyle("field-" + field.id)} className="max-w-36" key={field.id}>{editMode ? <InlineText value={profile.custom_fields[field.id] ?? ""} placeholder={field.name} disabled={!canEdit || !!busy || locked(profile.id)} onSave={(value) => patchProfile(profile, { customFields: { ...profile.custom_fields, [field.id]: value } })} /> : <span className="block truncate text-muted-foreground" title={profile.custom_fields[field.id] ?? ""}>{profile.custom_fields[field.id] || "—"}</span>}</TableCell>)}
            {shown("fingerprint") && <TableCell style={cellStyle("fingerprint")} className="max-w-40"><span className="block truncate text-muted-foreground" title={describeFingerprint(profile.fingerprint)}>{describeFingerprint(profile.fingerprint)}</span></TableCell>}
            {shown("updated") && <TableCell className="whitespace-nowrap text-muted-foreground">{dateTime(profile.updated_at)}</TableCell>}
            {shown("created") && <TableCell className="whitespace-nowrap text-muted-foreground">{dateTime(profile.created_at)}</TableCell>}
          </ProfileDragRow></ContextMenuTrigger><ContextMenuContent>
            <ContextMenuItem disabled={!runtime.available || !runtime.ready || runtime.restoring || processing || (!active && locked(profile.id))} onSelect={() => void (active ? runtime.stop(profile.id) : runtime.start(profile.id)).catch((error: Error) => toast.error(error.message))}>{active ? <Square className="size-4" /> : <Play className="size-4" />}{active ? "Закрыть" : "Открыть"}</ContextMenuItem>
            <ContextMenuItem disabled={!canEdit || !!busy || locked(profile.id)} onSelect={() => { setError(null); setEditing({ id: profile.id, name: profile.name, folder: profile.folder, tags: profile.tags.join(", "), notes: profile.notes, proxyId: profile.proxy_id ?? "none", fingerprint: profile.fingerprint, statusId: profile.status_id, customFields: profile.custom_fields }); }}><Pencil className="size-4" />Изменить</ContextMenuItem>
            <ContextMenuItem disabled={!canCreate || !!busy} onSelect={() => void perform(profile.id, () => cloneFn({ data: { id: profile.id } }))}><Copy className="size-4" />Создать копию</ContextMenuItem>
            <ContextMenuItem onSelect={() => setCookiesId(profile.id)}><Cookie className="size-4" />Cookies</ContextMenuItem>
            <ContextMenuItem disabled={!canDelete || !!busy || locked(profile.id)} onSelect={() => setAction({ mode: "delete", ids: [profile.id] })}><Trash2 className="size-4" />В корзину</ContextMenuItem>
          </ContextMenuContent></ContextMenu>;
        })}
        </SortableContext>
        {!profiles.isPending && !profiles.isError && !rows.length && <TableRow><TableCell colSpan={columnCount} className="py-10 text-center text-sm text-muted-foreground">{search ? "По выбранным фильтрам профилей нет" : "В этой папке пока нет профилей"}</TableCell></TableRow>}
      </TableBody></Table>
      </div>
    </div>

    {action && ws && <ProfileBulkDialog action={action.mode} ids={action.ids} teamId={ws.teamId} isOwner={manage} blocked={action.ids.some(locked)} proxies={proxies.data ?? []} folders={folderNames} onClose={() => setAction(null)} onSaved={() => { setSelected([]); refresh(); }} />}
    {cookiesProfile && <ProfileCookies profileId={cookiesProfile.id} name={cookiesProfile.name} isOwner={owner} locked={locked(cookiesProfile.id)} onClose={() => setCookiesId(null)} onSaved={refresh} />}
    {ws && <MetadataManager open={metadataOpen} onClose={() => setMetadataOpen(false)} statuses={metadata.data?.statuses ?? []} fields={metadata.data?.fields ?? []} busy={!!busy} onAddStatus={async (name, color) => { await perform("metadata", () => addStatusFn({ data: { teamId: ws.teamId, name, color: color as "primary" | "success" | "warning" | "destructive" | "muted" } }), () => void qc.invalidateQueries({ queryKey: ["profile-metadata"] })); }} onAddField={async (name, fieldType) => { await perform("metadata", () => addFieldFn({ data: { teamId: ws.teamId, name, fieldType: fieldType as "text" | "number" | "date" | "url" } }), () => void qc.invalidateQueries({ queryKey: ["profile-metadata"] })); }} onUpdateStatus={async (statusId, name, color) => { await perform("metadata", () => updateStatusFn({ data: { teamId: ws.teamId, statusId, name, color: color as "primary" | "success" | "warning" | "destructive" | "muted" } }), () => { void qc.invalidateQueries({ queryKey: ["profile-metadata"] }); refresh(); }); }} onDeleteStatus={async (statusId) => { await perform("metadata", () => deleteStatusFn({ data: { teamId: ws.teamId, statusId } }), () => { void qc.invalidateQueries({ queryKey: ["profile-metadata"] }); refresh(); }); }} />}
    <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !busy) setEditing(null); }}><DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>{editing?.id ? "Изменить профиль" : "Новый профиль"}</DialogTitle><DialogDescription>Настройки профиля и отпечатка</DialogDescription></DialogHeader>
      {editing && <fieldset disabled={!!busy} className="space-y-3">
        <Label className="grid gap-2">Название<Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Label>
        <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-2"><Label>Папка</Label><Select value={editing.folder || MAIN_FOLDER} disabled={folderList.isPending} onValueChange={(value) => setEditing({ ...editing, folder: value })}><SelectTrigger aria-label="Папка профиля"><SelectValue placeholder="Выберите папку" /></SelectTrigger><SelectContent>{folderNames.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select></div><Label className="grid gap-2">Метки через запятую<Input value={editing.tags} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} /></Label></div>
        <div className="space-y-2"><Label>Прокси</Label><Select disabled={!!busy || proxies.isPending || proxies.isError} value={editing.proxyId} onValueChange={(proxyId) => setEditing({ ...editing, proxyId })}><SelectTrigger aria-label="Прокси профиля"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Без прокси</SelectItem>{(proxies.data ?? []).map((proxy) => <SelectItem key={proxy.id} value={proxy.id}>{proxy.label} · {proxy.host}:{proxy.port}</SelectItem>)}</SelectContent></Select></div>
        <Label className="grid gap-2">Заметки<Textarea rows={5} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Label>
        {editing.id && owner && <div className="rounded-md border border-border bg-secondary/30 p-3 text-sm">
          <p className="font-medium">Cookies профиля</p>
          {cookieStatus.isPending ? <p className="text-muted-foreground">Проверяем сохранённые cookies…</p>
            : cookieStatus.isError ? <p role="alert" className="text-destructive">Не удалось проверить cookies. Повторите открытие профиля.</p>
            : cookieStatus.data?.total ? <p className="text-muted-foreground">Сохранено: {cookieStatus.data.total} · не истекли: {cookieStatus.data.usable}{cookieStatus.data.updatedAt ? ` · обновлены ${dateTime(cookieStatus.data.updatedAt)}` : ""}. Это не подтверждает, что сайт сохранил авторизацию.</p>
            : <p className="text-muted-foreground">Cookies ещё не импортированы.</p>}
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { setCookiesId(editing.id!); setEditing(null); }}>Открыть управление cookies</Button>
        </div>}
        <div className="space-y-2"><Label>Статус</Label><Select value={editing.statusId ?? "none"} onValueChange={(value) => setEditing({ ...editing, statusId: value === "none" ? null : value })}><SelectTrigger><SelectValue placeholder="Без статуса" /></SelectTrigger><SelectContent><SelectItem value="none">Без статуса</SelectItem>{(metadata.data?.statuses ?? []).map((status) => <SelectItem key={status.id} value={status.id}>{status.name}</SelectItem>)}</SelectContent></Select></div>
        {(metadata.data?.fields ?? []).map((field) => <Label key={field.id} className="grid gap-2">{field.name}<Input type={field.field_type === "number" ? "number" : field.field_type === "date" ? "date" : field.field_type === "url" ? "url" : "text"} value={editing.customFields[field.id] ?? ""} onChange={(event) => setEditing({ ...editing, customFields: { ...editing.customFields, [field.id]: event.target.value } })} /></Label>)}
        {!editing.id && <div className="space-y-2 rounded-md border border-border p-3">
          <div><Label htmlFor="new-profile-cookies">Cookies при создании (JSON / Netscape)</Label><p className="mt-1 text-xs text-muted-foreground">Вставьте cookies, проверьте число записей ниже и нажмите «Сохранить». После запуска профиля проверьте число установленных cookies на его стартовой странице. Одних cookies может быть недостаточно для входа, если сайт проверяет IP или Local Storage.</p></div>
          <Label className="grid gap-2">Файл cookies<Input type="file" accept=".json,.txt,application/json,text/plain" onChange={async (event) => {
            const file = event.target.files?.[0]; event.target.value = "";
            if (!file) return;
            if (file.size > MAX_COOKIE_IMPORT_BYTES) { setError("Файл cookies больше 5 МБ."); return; }
            try {
              const cookies = await file.text();
              setEditing((current) => current && !current.id ? { ...current, cookies } : current);
              setError(null);
            } catch { setError("Не удалось прочитать файл cookies."); }
          }} /></Label>
          <Textarea id="new-profile-cookies" rows={5} className="font-mono text-xs" value={editing.cookies ?? ""} onChange={(event) => setEditing({ ...editing, cookies: event.target.value })} placeholder={'[{"domain":".example.com","name":"session","value":"..."}] или Netscape cookies'} />
          {editingCookiesBytes > MAX_COOKIE_IMPORT_BYTES && <p role="alert" className="text-xs text-destructive">Cookies больше 5 МБ.</p>}
          {cookiePreview?.error && <p role="alert" className="text-xs text-destructive">Формат cookies не распознан. Нужен JSON-массив, объект с полем cookies или файл Netscape.</p>}
          {cookiePreview && !cookiePreview.error && <p role="status" className="text-xs text-muted-foreground">Распознано: {cookiePreview.count} · истекли: {cookiePreview.expired} · пригодны для установки: {cookiePreview.count - cookiePreview.expired}{cookiePreview.count === cookiePreview.expired ? ". Нужны действующие cookies." : ""}</p>}
        </div>}
        <ProfileFingerprint value={editing.fingerprint} onChange={(fingerprint) => setEditing({ ...editing, fingerprint })} disabled={!!busy} country={proxies.data?.find((p) => p.id === editing.proxyId)?.country} />
      </fieldset>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setEditing(null)}>Отмена</Button><Button disabled={!(editing?.id ? canEdit : canCreate) || !!busy || !editing?.name.trim() || editingCookiesBytes > MAX_COOKIE_IMPORT_BYTES || !!cookiePreview?.error || !!(cookiePreview && cookiePreview.count === cookiePreview.expired) || !!(editing && fingerprintError(editing.fingerprint)) || !!(editing?.id && locked(editing.id))} onClick={save}>{busy === "save" ? "Сохранение…" : "Сохранить"}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={bulkOpen} onOpenChange={(open) => { if (!busy) setBulkOpen(open); }}><DialogContent className="w-[calc(100%-2rem)]"><DialogHeader><DialogTitle>Создать несколько профилей</DialogTitle><DialogDescription>У каждого профиля будет отдельный отпечаток.</DialogDescription></DialogHeader>
      <fieldset disabled={!!busy} className="space-y-3"><Label className="grid gap-2">Название-основа<Input value={bulkForm.prefix} onChange={(e) => setBulkForm({ ...bulkForm, prefix: e.target.value })} /></Label><Label className="grid gap-2">Количество, 1–200<Input type="number" min={1} max={200} step={1} value={bulkForm.count} onChange={(e) => setBulkForm({ ...bulkForm, count: e.target.value })} /></Label><div className="space-y-2"><Label>Папка</Label><Select value={bulkForm.folder} disabled={folderList.isPending} onValueChange={(value) => setBulkForm({ ...bulkForm, folder: value })}><SelectTrigger aria-label="Папка новых профилей"><SelectValue placeholder="Выберите папку" /></SelectTrigger><SelectContent>{folderNames.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select></div></fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="space-y-2"><Label htmlFor="bulk-profile-os">Операционная система</Label><Select disabled={!!busy} value={bulkForm.os} onValueChange={(os) => setBulkForm({ ...bulkForm, os: os as FingerprintOS })}><SelectTrigger id="bulk-profile-os"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="windows">Windows</SelectItem><SelectItem value="macos">macOS · Apple Silicon</SelectItem></SelectContent></Select></div>
      <div className="space-y-2 rounded-md border border-border p-3"><div className="flex items-center justify-between gap-3"><Label htmlFor="bulk-profile-aggressive-privacy">Агрессивная блокировка API</Label><Switch id="bulk-profile-aggressive-privacy" checked={bulkForm.aggressivePrivacyMode} onCheckedChange={(checked) => setBulkForm({ ...bulkForm, aggressivePrivacyMode: checked })} disabled={!!busy} /></div><p className="text-xs text-muted-foreground">{bulkForm.aggressivePrivacyMode ? "Строгий режим ограничивает аппаратные API. Сайты могут заметить недоступность функций." : "Обычный режим снимает агрессивную блокировку API. В стандартном Electron доступные API могут раскрыть реальные GPU и шрифты устройства; согласованная подмена уровня Octo здесь не гарантируется."}</p></div>
      <DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setBulkOpen(false)}>Отмена</Button><Button disabled={!canCreate || !!busy || !validCount || !bulkForm.prefix.trim()} onClick={bulkCreate}>{busy === "create" ? "Создание…" : "Создать"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
