import { useId, useMemo, useState } from "react";
import { FileInput } from "lucide-react";
import { type Fingerprint } from "@/lib/fingerprint";
import { MAX_MIGRATION_BYTES, MIGRATION_PROBE, TG_CHANNEL_SETTINGS, parseMigrationSettings, previewMigration } from "@/lib/profile-migration";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

export function ProfileMigration({ value, onChange, disabled }: {
  value: Fingerprint; onChange: (value: Fingerprint) => void; disabled: boolean;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [fileError, setFileError] = useState("");
  const [reading, setReading] = useState(false);
  const preview = useMemo(() => {
    if (!text.trim()) return null;
    try { return { result: previewMigration(value, parseMigrationSettings(text)), error: "" }; }
    catch (error) { return { result: null, error: error instanceof Error ? error.message : "Настройки не распознаны." }; }
  }, [text, value]);
  function updateText(next: string) { setText(next); setConfirmed(false); setMessage(""); setFileError(""); }
  return <details className="min-w-0 rounded-md border border-border p-3">
    <summary className="cursor-pointer text-sm font-medium">Перенос настроек из Octo · Windows</summary>
    <div className="mt-3 min-w-0 space-y-3">
      <p className="text-xs text-muted-foreground">Помощник переносит только поддерживаемые настройки, не клонирует устройство. Это наш JSON настроек, не экспорт .octo. Вставляйте только публичные параметры — без cookies, паролей и токенов. Файл читается локально; изменения попадут в профиль после его сохранения.</p>
      <Button type="button" variant="outline" size="sm" disabled={disabled || reading} onClick={() => updateText(JSON.stringify(TG_CHANNEL_SETTINGS, null, 2))}><FileInput className="size-4" /> Образец TG CHANNEL</Button>
      <details className="min-w-0 text-xs">
        <summary className="cursor-pointer">Получить фактические параметры Octo</summary>
        <p className="my-2 text-muted-foreground">В исходном Windows-профиле откройте тестовую страницу HTTPS и консоль разработчика. Код ниже только читает публичные параметры и копирует JSON в буфер. Не запускайте его в консоли Umbra: нужны данные Octo. Вставьте результат в поле ниже и добавьте osVersion: «10» или «11» по настройкам исходного профиля. GPU, шрифты и WebRTC код не измеряет.</p>
        <pre className="max-h-48 overflow-auto rounded-md border border-border p-2">{MIGRATION_PROBE}</pre>
        <Button type="button" variant="outline" size="sm" className="mt-2" disabled={disabled || reading} onClick={async () => {
          try { await navigator.clipboard.writeText(MIGRATION_PROBE); setMessage("Код скопирован. Выполните его в консоли исходного Windows-профиля Octo, затем вставьте полученный JSON ниже."); }
          catch { setMessage("Буфер недоступен. Скопируйте показанный код вручную."); }
        }}>Скопировать код проверки</Button>
      </details>
      <Label className="grid gap-2">Файл публичных настроек JSON<Input type="file" accept=".json,application/json" disabled={disabled || reading} onChange={async (event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        setMessage(""); setConfirmed(false); setFileError("");
        if (file.size > MAX_MIGRATION_BYTES) { setFileError("Файл настроек превышает 16 КБ."); setText(""); return; }
        setReading(true); setText("");
        try { updateText(await file.text()); } catch { setFileError("Не удалось прочитать файл."); }
        finally { setReading(false); }
      }} /></Label>
      <Label htmlFor={id}>Публичные настройки источника</Label>
      <Textarea id={id} rows={8} value={text} maxLength={MAX_MIGRATION_BYTES} spellCheck={false} autoComplete="off" className="font-mono text-xs" disabled={disabled || reading} onChange={event => updateText(event.target.value)} />
      <p className="text-xs text-muted-foreground">В образце значения со скринов. Для языка, пояса и сообщаемой памяти укажите фактические languages, timezone и deviceMemory из исходного профиля. physicalMemoryGB — только справочная физическая RAM.</p>
      {(fileError || preview?.error) && <p role="alert" className="text-xs text-destructive">{fileError || preview?.error}</p>}
      {preview?.result && <>
        <ul aria-label="Совместимость переноса" className="space-y-2 text-xs">
          {preview.result.rows.map(row => <li key={row.parameter} className="break-words"><span className="font-medium">{row.parameter}: </span><span className={row.status === "warning" ? "text-warning" : "text-muted-foreground"}>{row.detail}</span></li>)}
        </ul>
        <label className="flex items-start gap-2 text-xs"><Checkbox checked={confirmed} disabled={disabled || reading} onCheckedChange={checked => setConfirmed(checked === true)} /><span>Понимаю ограничения: совпадение устройства и сохранение входа не гарантируются. Неизвестные параметры остаются текущими; оригинал в Octo сохраняю.</span></label>
        <Button type="button" variant="outline" size="sm" disabled={disabled || reading || !confirmed} onClick={() => {
          onChange(preview.result!.fingerprint); setConfirmed(false); setMessage("Поддерживаемые параметры применены к форме. Проверьте их и сохраните профиль; cookies импортируются отдельно.");
        }}>Применить поддерживаемые настройки</Button>
      </>}
      {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    </div>
  </details>;
}
