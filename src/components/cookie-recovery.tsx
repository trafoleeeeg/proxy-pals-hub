import { useState } from "react";
import { toast } from "sonner";
import { useDesktopProfileLifecycle } from "@/hooks/useDesktopProfileLifecycle";
import type { CookieVersionSummary } from "@/lib/desktop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function CookieVersion({ title, version }: { title: string; version: CookieVersionSummary | null }) {
  return <div className="min-w-0 rounded-md border border-border p-3 text-sm">
    <p className="font-medium">{title}</p>
    {version ? <><p className="mt-1 text-muted-foreground">Cookies: {version.count} · действующих: {version.activeCount}</p>
      <p className="break-words text-xs text-muted-foreground">{version.revision ? new Date(version.revision).toLocaleString() : "Дата неизвестна"}</p></> : <p className="text-muted-foreground">Нет локальной копии</p>}
  </div>;
}

export function CookieRecoveryAction({ profileId }: { profileId: string }) {
  const runtime = useDesktopProfileLifecycle();
  const recovery = runtime.recoveries?.[profileId];
  const [open, setOpen] = useState(false);
  const busy = runtime.busy.includes(profileId) || runtime.pending.includes(profileId) || runtime.restoring;
  if (!recovery) return null;
  async function choose(source: "local" | "cloud") {
    if (!recovery || busy) return;
    try { await runtime.start(profileId, { source, receiptId: recovery.receiptId }); setOpen(false); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Восстановление не выполнено. Обе версии сохранены."); }
  }
  return <>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => setOpen(true)}>Восстановить: {recovery.name}</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle className="break-words">Восстановление: {recovery.name}</DialogTitle>
        <DialogDescription>Локальная и облачная версии cookies различаются. Выберите, какую сессию открыть. До замены обе копии будут сохранены в зашифрованном резерве на этом компьютере.</DialogDescription></DialogHeader>
      {recovery.changed && <p role="alert" className="text-sm text-warning">Данные изменились после предыдущего выбора. Проверьте обновлённые версии.</p>}
      <div className="grid gap-3 sm:grid-cols-2"><CookieVersion title="На этом компьютере" version={recovery.local} /><CookieVersion title="В облаке" version={recovery.cloud} /></div>
      <p className="text-sm text-muted-foreground">Выбранная версия будет синхронизирована в облако при сохранении профиля. Резерв позволяет вернуть предыдущую копию через окно Cookies этого профиля. Другие данные сайтов и настройки профиля не заменяются.</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !recovery.local} onClick={() => void choose("local")}>Восстановить локальную</Button>
        <Button variant="outline" disabled={busy} onClick={() => void choose("cloud")}>Использовать облачную</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Отмена</Button>
      </div>
    </DialogContent></Dialog>
  </>;
}
