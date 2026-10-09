import { useEffect, useId, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Download, Upload } from "lucide-react";
import { importProfileCookies, exportProfileCookies } from "@/lib/profiles.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cookiesToNetscape } from "./profile-model";
import { parseCookieImport, cookieImportErrorMessage } from "@/lib/server-cookies";
import { desktop, type CookieRecoveryBackup } from "@/lib/desktop";
import { useDesktopProfileLifecycle } from "@/hooks/useDesktopProfileLifecycle";
import { CookieVersion } from "@/components/cookie-recovery";

const MAX_COOKIE_IMPORT_BYTES = 5_000_000;

export function ProfileCookies({ profileId, name, isOwner, locked, onClose, onSaved }: {
  profileId: string; name: string; isOwner: boolean; locked: boolean; onClose: () => void; onSaved: () => void;
}) {
  const importFn = useServerFn(importProfileCookies);
  const runtime = useDesktopProfileLifecycle();
  const bridge = desktop();
  const [backups, setBackups] = useState<CookieRecoveryBackup[]>([]);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [restoreChoice, setRestoreChoice] = useState<{ backup: CookieRecoveryBackup; source: "local" | "cloud" } | null>(null);
  const contentId = useId();
  const exportFn = useServerFn(exportProfileCookies);
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [format, setFormat] = useState("json");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const allowed = isOwner && !locked;
  useEffect(() => {
    let disposed = false;
    if (isOwner && bridge?.listCookieRecoveryBackups) void bridge.listCookieRecoveryBackups(profileId).then(result => {
      if (disposed) return;
      if (!result.ok || !result.backups) throw new Error();
      setBackups(result.backups);
    }).catch(() => { if (!disposed) setBackupError("Не удалось прочитать зашифрованный резерв cookies. Существующие копии не изменены."); });
    return () => { disposed = true; };
  }, [profileId, isOwner, bridge]);
  async function restoreBackup() {
    if (!restoreChoice || !allowed || busy || runtime.busy.includes(profileId)) return;
    setBusy(true); setError(null);
    try {
      await runtime.start(profileId, { backupId: restoreChoice.backup.backupId, source: restoreChoice.source });
      setRestoreChoice(null); onSaved(); onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Не удалось восстановить резерв. Данные сохранены."); }
    finally { setBusy(false); }
  }
  const bytes = new Blob([text]).size;
  const preview = useMemo(() => {
    if (!text.trim() || bytes > MAX_COOKIE_IMPORT_BYTES) return null;
    try {
      const cookies = parseCookieImport(text);
      return { count: cookies.length, partitions: cookies.filter(cookie => cookie.partitionKey).length, expired: cookies.filter((cookie) => cookie.expirationDate != null && cookie.expirationDate <= Date.now() / 1000).length, error: false };
    } catch (error) { return { count: 0, partitions: 0, expired: 0, error: true, message: cookieImportErrorMessage(error) }; }
  }, [text, bytes]);

  async function importCookies() {
    if (!allowed || !confirmed || busy || !text.trim() || !preview || preview.error || preview.count === preview.expired) return;
    setBusy(true); setError(null); setMessage("");
    try {
      const result = await importFn({ data: { profileId, text } });
      setText(""); setConfirmed(false);
      setMessage(`В облако сохранено cookies: ${result.imported}. Запустите профиль и проверьте число реально установленных cookies на стартовой странице.`); onSaved();
    } catch { setError("Импорт не выполнен. Проверьте JSON или Netscape, доступ владельца и блокировку профиля."); }
    finally { setBusy(false); }
  }

  async function exportCookies() {
    if (!isOwner || busy) return;
    setBusy(true); setError(null); setMessage("");
    let url: string | undefined;
    try {
      const result = await exportFn({ data: { profileId } });
      const content = format === "netscape" ? cookiesToNetscape(result.cookies) : result.cookies;
      url = URL.createObjectURL(new Blob([content], { type: format === "json" ? "application/json" : "text/plain" }));
      const link = document.createElement("a");
      link.href = url; link.download = `profile-${profileId}-cookies.${format === "json" ? "json" : "txt"}`;
      document.body.appendChild(link); link.click(); link.remove();
      setMessage("Файл cookies выгружен.");
    } catch { setError("Экспорт не выполнен. Проверьте доступ владельца; для несовместимых с Netscape cookies выберите JSON."); }
    finally {
      if (url) { const objectUrl = url; window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); }
      setBusy(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-xl">
    <DialogHeader className="min-w-0 pr-5"><DialogTitle className="break-all leading-snug tracking-normal">Cookies: {name}</DialogTitle><DialogDescription>Облачная синхронизация включает только cookies. Local Storage хранится на этом компьютере. Некоторые сайты дополнительно проверяют IP, устройство или другие данные сессии — одних cookies может не хватить для входа.</DialogDescription></DialogHeader>
    {!isOwner ? <p role="alert" className="text-sm text-muted-foreground">Импорт и экспорт доступны только владельцу.</p> : <>
      <section className="space-y-3 border-t border-border pt-3">
        <h3 className="text-sm font-medium">Импорт JSON / Netscape</h3>
        {locked && <p role="alert" className="text-sm text-warning">Импорт недоступен: профиль открыт или ожидает синхронизации.</p>}
        <Label className="grid gap-2">Файл cookies<Input type="file" accept=".json,.txt,application/json,text/plain" disabled={!allowed || busy} onChange={async (e) => {
          const file = e.target.files?.[0]; e.target.value = "";
          if (!file) return;
          if (file.size > MAX_COOKIE_IMPORT_BYTES) { setError("Файл превышает 5 МБ."); return; }
          setBusy(true); setError(null); setConfirmed(false);
          try { setText(await file.text()); } catch { setError("Не удалось прочитать файл."); }
          finally { setBusy(false); }
        }} /></Label>
        <div className="grid min-w-0 gap-2"><Label htmlFor={contentId}>Содержимое</Label><Textarea id={contentId} rows={7} value={text} autoComplete="off" spellCheck={false} disabled={!allowed || busy} onChange={(e) => { setText(e.target.value); setConfirmed(false); }} className="font-mono text-xs" /></div>
        {bytes > MAX_COOKIE_IMPORT_BYTES && <p role="alert" className="text-sm text-destructive">Содержимое превышает 5 МБ.</p>}
        {preview?.error && <p role="alert" className="text-sm text-destructive">{preview.message}</p>}
        {!!preview?.partitions && !preview.error && <p className="text-xs text-muted-foreground">CHIPS cookies: {preview.partitions}. Нужен обновлённый клиент Umbra с поддержкой разделённых cookies. Для старых ключей без hasCrossSiteAncestor применяется правило совместимости Chrome; точное исходное значение отсутствует в экспорте.</p>}
        {preview && !preview.error && <p role="status" className="text-xs text-muted-foreground">Распознано: {preview.count} · истекли: {preview.expired} · пригодны для установки: {preview.count - preview.expired}{preview.count === preview.expired ? ". Нужны действующие cookies." : ""}</p>}
        <label className="flex items-start gap-2 text-sm"><Checkbox checked={confirmed} disabled={!allowed || busy} onCheckedChange={(v) => setConfirmed(v === true)} /> Заменить облачные cookies профиля содержимым импорта</label>
        <Button disabled={!allowed || busy || !confirmed || !preview || preview.error || preview.count === preview.expired || bytes > MAX_COOKIE_IMPORT_BYTES} onClick={importCookies}><Upload className="size-4" />{busy ? "Выполняется…" : "Импортировать"}</Button>
      </section>
      <section className="space-y-3 border-t border-border pt-3">
        <h3 className="text-sm font-medium">Экспорт облачных cookies</h3>
        <div className="flex flex-wrap items-center gap-2"><Select value={format} disabled={busy} onValueChange={setFormat}><SelectTrigger aria-label="Формат экспорта cookies" className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="json">JSON</SelectItem><SelectItem value="netscape">Netscape</SelectItem></SelectContent></Select><Button variant="outline" disabled={busy} onClick={exportCookies}><Download className="size-4" /> Выгрузить файл</Button></div>
      </section>
      {bridge?.listCookieRecoveryBackups && <section className="space-y-3 border-t border-border pt-3">
        <h3 className="text-sm font-medium">Зашифрованный резерв восстановления</h3>
        <p className="text-xs text-muted-foreground">Хранится на этом компьютере. Возврат открывает профиль с выбранной копией; текущие локальные и облачные cookies сначала сохраняются в новый резерв.</p>
        {backupError && <p role="alert" className="text-sm text-destructive">{backupError}</p>}
        {!backupError && !backups.length && <p className="text-sm text-muted-foreground">Резервных копий пока нет.</p>}
        {backups.map(backup => <div key={backup.backupId} className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm">{new Date(backup.createdAt).toLocaleString()}</p>
          <div className="grid gap-2 sm:grid-cols-2"><CookieVersion title="Локальная копия" version={backup.local} /><CookieVersion title="Облачная копия" version={backup.cloud} /></div>
          <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={!allowed || busy || !backup.local} onClick={() => setRestoreChoice({ backup, source: "local" })}>Вернуть локальную</Button>
            <Button variant="outline" size="sm" disabled={!allowed || busy} onClick={() => setRestoreChoice({ backup, source: "cloud" })}>Вернуть облачную</Button></div>
        </div>)}
        {restoreChoice && <div role="alert" className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm">Открыть профиль с {restoreChoice.source === "local" ? "локальной" : "облачной"} копией из резерва от {new Date(restoreChoice.backup.createdAt).toLocaleString()}? При сохранении она заменит облачные cookies. Текущие версии будут сохранены в резерв.</p>
          <div className="flex gap-2"><Button disabled={!allowed || busy} onClick={() => void restoreBackup()}>Подтвердить возврат</Button><Button variant="ghost" disabled={busy} onClick={() => setRestoreChoice(null)}>Отмена</Button></div>
        </div>}
      </section>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="text-sm text-success">{message}</p>}
  </DialogContent></Dialog>;
}
