import { createFileRoute } from "@tanstack/react-router";
import { Download, Loader2, Monitor, Puzzle, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useDesktopProfileLifecycle } from "@/hooks/useDesktopProfileLifecycle";
import { desktop, type InstalledExtension } from "@/lib/desktop";
import { Button } from "@/components/ui/button";

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
    <ExtensionManager />
    <section className="space-y-2 text-sm text-muted-foreground">
      <h2 className="font-semibold text-foreground">Данные профилей</h2>
      <p>Облачная синхронизация переносит только cookies. Local Storage, IndexedDB и остальные локальные данные сайтов остаются на текущем компьютере.</p>
      <p>Состояние открытых вкладок и полный браузерный профиль между устройствами не переносятся.</p>
    </section>
  </div>;
}

function ExtensionManager() {
  const bridge = desktop();
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [busy, setBusy] = useState(false);
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
  return <section className="space-y-4 border-y border-border py-5">
    {loadError && <p role="alert" className="text-sm text-destructive">Не удалось прочитать набор расширений. Перезапустите приложение и повторите.</p>}
    <div className="flex flex-wrap items-center gap-3">
      <div><h2 className="flex items-center gap-2 font-semibold"><Puzzle className="size-4" />Расширения профилей</h2><p className="mt-1 text-sm text-muted-foreground">Распакованные расширения подключаются к открытым и новым профилям на этом компьютере.</p></div>
      <Button className="ml-auto" variant="outline" disabled={busy} onClick={add}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Puzzle className="size-4" />}Добавить расширение</Button>
    </div>
    {extensions.length ? <ul className="grid gap-2 sm:grid-cols-2" aria-label="Подключённые расширения">{extensions.map((extension) => <li key={extension.id} className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-secondary/20 px-3 py-2"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{extension.name}</p><p className="text-xs text-muted-foreground">Версия {extension.version}</p></div><Button size="icon" variant="ghost" title="Удалить расширение" aria-label={`Удалить ${extension.name}`} disabled={busy} onClick={() => { void remove(extension.id); }}><Trash2 className="size-4 text-destructive" /></Button></li>)}</ul> : <p className="text-sm text-muted-foreground">Пока нет предустановленных расширений.</p>}
  </section>;
}
