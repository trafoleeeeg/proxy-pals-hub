import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { desktop, type UpdateStatus } from "@/lib/desktop";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/app/desktop")({
  component: ClientPage,
});

const RELEASES = "https://github.com/trafoleeeeg/proxy-pals-hub/releases/latest";

const STEPS = [
  "Скачайте приложение для своей системы и установите его.",
  "Войдите в приложении той же почтой — увидите те же профили, что и здесь.",
  "Вход через Google открывается в вашем обычном браузере и возвращается в приложение.",
  "Запускайте профили из приложения: оно открывает отдельный изолированный браузер.",
  "Пока профиль открыт у одного сотрудника, другие увидят его как занятый.",
];

function ClientPage() {
  const bridge = desktop();
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const b = desktop();
    if (!b) return;
    b.appVersion().then(setVersion);
    return b.onUpdateStatus(setStatus);
  }, []);

  async function check() {
    const b = desktop();
    if (!b) return;
    setBusy(true);
    const r = await b.checkUpdate();
    setBusy(false);
    if (!r.ok) toast.error(r.error || "Не удалось проверить обновления");
  }

  async function update() {
    const b = desktop();
    if (!b) return;
    setBusy(true);
    const r = await b.downloadUpdate();
    setBusy(false);
    if (!r.ok) toast.error(r.error || "Не удалось скачать обновление");
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">Настольное приложение</h1>
      <p className="mt-2 text-muted-foreground">
        Профили запускаются только из приложения — так данные аккаунтов не пересекаются с вашим
        обычным браузером.
      </p>

      {bridge ? (
        <div className="mt-8 rounded-lg border border-border bg-card p-6">
          <h2 className="font-semibold">Обновление</h2>
          <p className="mono mt-1 text-xs text-muted-foreground">
            установленная версия {version ?? "…"}
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            {!status && "Нажмите «Проверить обновления»."}
            {status?.state === "none" && "У вас последняя версия."}
            {status?.state === "available" && `Доступна версия ${status.version}.`}
            {status?.state === "downloading" && `Загрузка… ${status.percent}%`}
            {status?.state === "downloaded" &&
              `Версия ${status.version} готова. Приложение перезапустится, все профили и данные сохранятся.`}
            {status?.state === "error" && `Ошибка: ${status.error}`}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" onClick={check} disabled={busy}>
              Проверить обновления
            </Button>
            {status?.state === "available" && (
              <Button onClick={update} disabled={busy}>
                Скачать обновление
              </Button>
            )}
            {status?.state === "downloaded" && (
              <Button onClick={() => bridge.installUpdate()}>Установить и перезапустить</Button>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-6">
            <h2 className="font-semibold">Windows</h2>
            <p className="mt-1 text-sm text-muted-foreground">Windows 10 и 11, 64 бита</p>
            <a
              href={RELEASES}
              target="_blank"
              rel="noreferrer"
              className="mono mt-4 inline-block text-xs text-primary hover:underline"
            >
              скачать последнюю версию →
            </a>
          </div>
          <div className="rounded-lg border border-border bg-card p-6">
            <h2 className="font-semibold">macOS</h2>
            <p className="mt-1 text-sm text-muted-foreground">macOS 12 и новее</p>
            <p className="mono mt-4 text-xs text-muted-foreground">сборка готовится</p>
          </div>
        </div>
      )}

      <ol className="mt-8 space-y-3">
        {STEPS.map((s, i) => (
          <li key={s} className="flex gap-3 text-sm">
            <span className="mono text-primary">{String(i + 1).padStart(2, "0")}</span>
            <span className="text-muted-foreground">{String(i + 1) && s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
