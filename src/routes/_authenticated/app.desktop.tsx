import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bookmark, Download, Link as LinkIcon, Loader2, Monitor, Plus, Puzzle, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useDesktopProfileLifecycle } from "@/hooks/useDesktopProfileLifecycle";
import { desktop, type InstalledExtension } from "@/lib/desktop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkspace } from "@/lib/useWorkspace";
import { usePermissions } from "@/lib/usePermissions";
import { getBookmarkDefaults, saveBookmarkDefaults } from "@/lib/bookmark-defaults.functions";
import type { BookmarkDefaults } from "@/lib/bookmark-defaults";

export const Route = createFileRoute("/_authenticated/app/desktop")({ component: ClientPage });
const RELEASES = "https://github.com/trafoleeeeg/proxy-pals-hub/releases/latest";

export function ClientPage() {
  const runtime = useDesktopProfileLifecycle();
  const { status, version, busy, error } = runtime.update;
  return <div className="max-w-3xl space-y-6">
    <div><h1 className="flex items-center gap-2 text-2xl font-semibold"><Monitor className="size-6" />Umbra для Windows</h1><p className="mt-2 text-sm text-muted-foreground">Windows 10 и 11, 64 бита</p></div>
    {runtime.available ? <section className="space-y-4 border-y border-border py-5">
      <h2 className="text-base font-semibold">Обновление приложения</h2>
      <p className="font-mono text-xs text-muted-foreground">Установленная версия: {version ?? "Загрузка…"}</p>
      <p role="status" className="text-sm">
        {!status && "Получение статуса обновления…"}
        {status?.state === "none" && "Доступных обновлений нет."}
        {status?.state === "checking" && "Проверка обновлений…"}
        {status?.state === "available" && "Доступна версия " + status.version}
        {status?.state === "downloading" && "Загрузка обновления: " + status.percent + "%"}
        {status?.state === "downloaded" && "Версия " + status.version + " готова к установке."}
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || status?.state === "checking" || status?.state === "downloading"} onClick={() => runtime.updateAction("check")}><RefreshCw className="size-4" />Проверить обновления</Button>
        {status?.state === "available" && <Button disabled={busy} onClick={() => runtime.updateAction("download")}><Download className="size-4" />Скачать</Button>}
        {status?.state === "downloaded" && <Button disabled={busy} onClick={() => runtime.updateAction("install")}>Установить и перезапустить</Button>}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground"><span>Открыто профилей: {runtime.running.length}</span><span>Ожидают синхронизации: {runtime.pending.length}</span></div>
    </section> : <section className="space-y-4 border-y border-border py-5"><h2 className="font-semibold">Установщик Windows</h2><a href={RELEASES} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm text-primary hover:underline"><Download className="size-4" />Скачать установщик из последнего релиза</a></section>}
    <BookmarkDefaultsManager />
    <ExtensionManager />
    <section className="space-y-2 text-sm text-muted-foreground">
      <h2 className="font-semibold text-foreground">Данные профилей</h2>
      <p>Облачная синхронизация переносит только cookies. Local Storage, IndexedDB и остальные локальные данные сайтов остаются на текущем компьютере.</p>
      <p>Состояние открытых вкладок и полный браузерный профиль между устройствами не переносятся.</p>
    </section>
  </div>;
}

function BookmarkDefaultsManager() {
  const workspace = useWorkspace();
  const ws = workspace.data;
  const load = useServerFn(getBookmarkDefaults);
  const save = useServerFn(saveBookmarkDefaults);
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["bookmark-defaults", ws?.teamId],
    queryFn: () => load({ data: { teamId: ws!.teamId } }),
    enabled: !!ws,
  });
  const [rows, setRows] = useState<BookmarkDefaults["bookmarks"]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!query.data || dirty) return;
    setRows(query.data.bookmarks);
  }, [dirty, query.data]);
  const { can, isError: permissionsError } = usePermissions(ws?.teamId);
  const canManage = can("bookmarks.manage");
  function change(id: string, field: "title" | "url", value: string) {
    setRows((current) => current.map((item) => item.id === id ? { ...item, [field]: value } : item));
    setDirty(true);
  }
  function add() {
    setRows((current) => [...current, { id: crypto.randomUUID(), title: "Новая закладка", url: "https://" }]);
    setDirty(true);
  }
  async function persist() {
    if (!ws || busy) return;
    const normalized = rows.map((item) => ({ ...item, title: item.title.trim(), url: item.url.trim() }));
    try {
      for (const item of normalized) {
        const url = new URL(item.url);
        if (!/^https?:$/.test(url.protocol)) throw new Error("Разрешены только ссылки HTTP и HTTPS");
        if (!item.title) throw new Error("Укажите название каждой закладки");
      }
      setBusy(true);
      const saved = await save({ data: { teamId: ws.teamId, bookmarks: normalized, bookmarkBarVisible: true } });
      qc.setQueryData(["bookmark-defaults", ws.teamId], saved);
      await desktop()?.pushBookmarkDefaults?.(saved);
      setRows(saved.bookmarks); setDirty(false);
      await qc.invalidateQueries({ queryKey: ["bookmark-defaults", ws.teamId] });
      toast.success("Общие закладки сохранены для всех профилей");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось сохранить общие закладки");
    } finally { setBusy(false); }
  }
  return <section className="space-y-4 border-y border-border py-5">
    {permissionsError && <p role="alert" className="text-sm text-destructive">Не удалось загрузить ваши права. Обновите страницу и повторите попытку.</p>}
    <div className="flex flex-wrap items-center gap-3">
      <div><h2 className="flex items-center gap-2 font-semibold"><Bookmark className="size-4" />Общие закладки</h2><p className="mt-1 text-sm text-muted-foreground">Эта панель показывается во всех профилях команды. Личные закладки профиля сохраняются отдельно.</p></div>
      {canManage && <div className="ml-auto flex gap-2"><Button variant="outline" disabled={busy || rows.length >= 64} onClick={add}><Plus className="size-4" />Добавить ссылку</Button><Button disabled={busy || !dirty} onClick={() => { void persist(); }}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}Сохранить</Button></div>}
    </div>
    {query.isPending ? <p className="text-sm text-muted-foreground">Загрузка закладок…</p> : query.isError ? <p role="alert" className="text-sm text-destructive">Не удалось загрузить общие закладки.</p> : rows.length ? <div className="space-y-2">{rows.map((item) => <div key={item.id} className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-[minmax(140px,.6fr)_minmax(220px,1fr)_auto]">
      <Input aria-label="Название закладки" value={item.title} disabled={!canManage || busy} maxLength={120} onChange={(event) => change(item.id, "title", event.target.value)} />
      <Input aria-label="Адрес закладки" value={item.url} disabled={!canManage || busy} maxLength={2048} onChange={(event) => change(item.id, "url", event.target.value)} />
      {canManage && <Button size="icon" variant="ghost" aria-label={`Удалить ${item.title}`} disabled={busy} onClick={() => { setRows((current) => current.filter((row) => row.id !== item.id)); setDirty(true); }}><Trash2 className="size-4 text-destructive" /></Button>}
    </div>)}</div> : <p className="text-sm text-muted-foreground">Общих закладок пока нет.</p>}
  </section>;
}

function ExtensionManager() {
  const bridge = desktop();
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const supported = !!(bridge?.listExtensions && bridge.addExtension && bridge.removeExtension);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    if (!bridge?.listExtensions) return;
    let active = true;
    void bridge.listExtensions().then((result) => {
      if (!active) return;
      if (result.ok) setExtensions(result.extensions ?? []);
      else setLoadError(true);
    }).catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [bridge]);
  if (!supported) return <section className="space-y-2 border-y border-border py-5 text-sm">
    <h2 className="flex items-center gap-2 font-semibold"><Puzzle className="size-4" />Расширения профилей</h2>
    <p className="text-muted-foreground">{bridge ? "Обновите приложение Windows, чтобы управлять расширениями." : "Управление расширениями доступно в установленном приложении Windows."}</p>
  </section>;
  const activeBridge = bridge!;
  async function add() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await activeBridge.addExtension!();
      if (!result.ok || !result.extension) {
        if (result.error && !result.error.includes("отменено")) toast.error(result.error);
        return;
      }
      setExtensions((current) => [...current.filter((item) => item.id !== result.extension!.id), result.extension!]);
      if (result.failures) toast.warning("Набор сохранён, но в некоторых профилях расширение не загрузилось. Проверьте совместимость расширения.");
      else toast.success("Расширение подключено к текущим и новым профилям");
    } catch { toast.error("Не удалось добавить расширение"); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await activeBridge.removeExtension!(id);
      if (!result.ok) throw new Error(result.error);
      setExtensions((current) => current.filter((item) => item.id !== id));
      toast.success("Расширение удалено из набора профилей");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось удалить расширение"); }
    finally { setBusy(false); }
  }
  function apply(extension: InstalledExtension, failures?: number) {
    setExtensions((current) => [...current.filter((item) => item.id !== extension.id), extension]);
    if (failures) toast.warning("Набор сохранён, но в некоторых профилях расширение не загрузилось. Проверьте совместимость расширения.");
    else toast.success("Расширение подключено к текущим и новым профилям");
  }
  async function addByUrl() {
    const value = link.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const result = await activeBridge.addExtensionFromUrl!(value);
      if (!result.ok || !result.extension) throw new Error(result.error);
      apply(result.extension, result.failures);
      setLink("");
    } catch (error) { toast.error(error instanceof Error && error.message ? error.message : "Не удалось добавить расширение по ссылке"); }
    finally { setBusy(false); }
  }
  async function refresh(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await activeBridge.updateExtension!(id);
      if (!result.ok || !result.extension) throw new Error(result.error);
      apply(result.extension, result.failures);
    } catch (error) { toast.error(error instanceof Error && error.message ? error.message : "Не удалось обновить расширение"); }
    finally { setBusy(false); }
  }
  const linkSupported = !!activeBridge.addExtensionFromUrl;
  return <section className="space-y-4 border-y border-border py-5">
    {loadError && <p role="alert" className="text-sm text-destructive">Не удалось прочитать набор расширений. Перезапустите приложение и повторите.</p>}
    <div className="flex flex-wrap items-center gap-3">
      <div><h2 className="flex items-center gap-2 font-semibold"><Puzzle className="size-4" />Расширения профилей</h2><p className="mt-1 text-sm text-muted-foreground">Расширения подключаются к открытым и новым профилям на этом компьютере.</p></div>
      <Button className="ml-auto" variant="outline" disabled={busy} onClick={add}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Puzzle className="size-4" />}Добавить папкой</Button>
    </div>
    {linkSupported ? <div className="space-y-2">
      <label htmlFor="extension-link" className="text-sm font-medium">Ссылка на расширение</label>
      <div className="flex flex-wrap gap-2">
        <Input id="extension-link" value={link} placeholder="https://chromewebstore.google.com/detail/… или прямая ссылка на .crx" disabled={busy} onChange={(event) => setLink(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addByUrl(); } }} className="min-w-64 flex-1" />
        <Button disabled={busy || !link.trim()} onClick={() => { void addByUrl(); }}>{busy ? <Loader2 className="size-4 animate-spin" /> : <LinkIcon className="size-4" />}Добавить по ссылке</Button>
      </div>
      <p className="text-xs text-muted-foreground">Подойдёт ссылка из магазина Chrome или прямая ссылка на файл .crx либо .zip с сайта сервиса.</p>
    </div> : <p className="text-sm text-muted-foreground">Обновите приложение Windows, чтобы добавлять расширения ссылкой.</p>}
    {extensions.length ? <ul className="grid gap-2 sm:grid-cols-2" aria-label="Подключённые расширения">{extensions.map((extension) => <li key={extension.id} className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-secondary/20 px-3 py-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{extension.name}</p><p className="truncate text-xs text-muted-foreground">Версия {extension.version}{extension.source === "store" ? " · магазин Chrome" : extension.source === "url" ? " · по ссылке" : " · из папки"}</p></div>{extension.source && <Button size="icon" variant="ghost" title="Обновить расширение" aria-label={`Обновить ${extension.name}`} disabled={busy} onClick={() => { void refresh(extension.id); }}><RefreshCw className="size-4" /></Button>}<Button size="icon" variant="ghost" title="Удалить расширение" aria-label={`Удалить ${extension.name}`} disabled={busy} onClick={() => { void remove(extension.id); }}><Trash2 className="size-4 text-destructive" /></Button></li>)}</ul> : <p className="text-sm text-muted-foreground">Пока нет предустановленных расширений.</p>}
  </section>;
}
