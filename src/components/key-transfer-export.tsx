import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Download, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/lib/useWorkspace";
import { exportEncryptedMigrationKey, getKeyTransferStatus } from "@/lib/key-transfer.functions";

type TransferStatus = Awaited<ReturnType<typeof getKeyTransferStatus>>;

export function KeyTransferExport() {
  const workspace = useWorkspace();
  const check = useServerFn(getKeyTransferStatus);
  const exportKey = useServerFn(exportEncryptedMigrationKey);
  const [status, setStatus] = useState<TransferStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!workspace.data?.isSuperadmin) return null;

  async function checkStatus() {
    setBusy(true); setMessage(""); setStatus(null);
    try { setStatus(await check({ data: {} })); }
    catch { setMessage("Перенос недоступен. Для этой операции нужен повторный вход по паролю в последние 10 минут и согласованное окно переноса."); }
    finally { setBusy(false); }
  }
  async function download() {
    if (!status?.enabled || busy) return;
    setBusy(true); setMessage("");
    try {
      const envelope = await exportKey({ data: {} });
      const url = URL.createObjectURL(new Blob([JSON.stringify(envelope)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `umbra-key-transfer-${envelope.transferId}.json`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("Создан только зашифрованный контейнер. Исходный ключ, cookies и база не изменены. Сохраните файл для локальной проверки; не отправляйте его в чат.");
    } catch { setMessage("Контейнер не получен. Ключ и данные не изменены. Проверьте окно переноса и повторный вход по паролю."); }
    finally { setBusy(false); }
  }
  return <details className="space-y-3 border-y border-border py-5">
    <summary className="cursor-pointer text-sm font-semibold">Защищённый перенос хостинга</summary>
    <p className="mt-3 text-sm text-muted-foreground">Временная операция только для владельца Umbra. Старый ключ не заменяется: он передаётся в контейнере, который может открыть только заранее закреплённый получатель.</p>
    <Button variant="outline" disabled={busy} onClick={() => { void checkStatus(); }}><ShieldCheck className="size-4" />Проверить готовность переноса</Button>
    {status && !status.enabled && <p role="status" className="text-sm text-muted-foreground">Операция выключена. Сначала необходимо согласовать и включить короткое окно переноса.</p>}
    {status?.enabled && <div className="space-y-2 rounded-md border border-border p-3 text-sm">
      <p>Источник: {status.sourceOrigin}</p><p>Назначение: {status.targetOrigin}</p>
      <p>Окно действительно до: {status.expiresAt}</p>
      <p className="break-all font-mono text-xs">Отпечаток ключа получателя: {status.keyId}</p>
      <Button disabled={busy} onClick={() => { void download(); }}><Download className="size-4" />Скачать зашифрованный контейнер</Button>
    </div>}
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
  </details>;
}
