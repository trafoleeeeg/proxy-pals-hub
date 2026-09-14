import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/app/desktop")({
  component: ClientPage,
});

const STEPS = [
  "Скачайте приложение для своей системы и установите его.",
  "Войдите в приложении той же почтой — увидите те же профили, что и здесь.",
  "Запускайте профили из приложения: оно открывает отдельный изолированный браузер.",
  "Пока профиль открыт у одного сотрудника, другие увидят его как занятый.",
];

function ClientPage() {
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold">Настольное приложение</h1>
      <p className="mt-2 text-muted-foreground">
        Профили запускаются только из приложения — так данные аккаунтов не пересекаются с вашим
        обычным браузером.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="font-semibold">Windows</h2>
          <p className="mt-1 text-sm text-muted-foreground">Windows 10 и 11, 64 бита</p>
          <p className="mono mt-4 text-xs text-muted-foreground">сборка готовится</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="font-semibold">macOS</h2>
          <p className="mt-1 text-sm text-muted-foreground">macOS 12 и новее</p>
          <p className="mono mt-4 text-xs text-muted-foreground">сборка готовится</p>
        </div>
      </div>

      <ol className="mt-8 space-y-3">
        {STEPS.map((s, i) => (
          <li key={s} className="flex gap-3 text-sm">
            <span className="mono text-primary">{String(i + 1).padStart(2, "0")}</span>
            <span className="text-muted-foreground">{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
