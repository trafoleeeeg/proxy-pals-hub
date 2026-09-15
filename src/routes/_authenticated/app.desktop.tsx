import { createFileRoute } from "@tanstack/react-router";
import { Download, Monitor, RefreshCw } from "lucide-react";
import { useDesktopProfileLifecycle } from "@/hooks/useDesktopProfileLifecycle";
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
    <section className="space-y-2 text-sm text-muted-foreground">
      <h2 className="font-semibold text-foreground">Данные профилей</h2>
      <p>Облачная синхронизация переносит только cookies. Local Storage, IndexedDB и остальные локальные данные сайтов остаются на текущем компьютере.</p>
      <p>Состояние открытых вкладок и полный браузерный профиль между устройствами не переносятся.</p>
    </section>
  </div>;
}
