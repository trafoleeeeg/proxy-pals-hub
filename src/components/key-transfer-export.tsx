import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Download, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/lib/useWorkspace";
import { exportEncryptedMigrationKey, getKeyTransferStatus } from "@/lib/key-transfer.functions";
import type { KeyTransferFailureCode } from "@/lib/key-transfer.server";

type TransferStatus = Awaited<ReturnType<typeof getKeyTransferStatus>>;
const failureMessages: Record<KeyTransferFailureCode, string> = {
  source_key_unavailable: "Источник не предоставил ключ шифрования. Код: source_key_unavailable. Ключ и данные не изменены.",
  crypto_import_failed: "Не удалось загрузить серверный модуль шифрования. Код: crypto_import_failed. Ключ и данные не изменены.",
  canary_failed: "Не удалось выполнить синтетическую проверку шифрования. Код: canary_failed. Ключ и данные не изменены.",
  seal_failed: "Не удалось зашифровать контейнер для закреплённого получателя. Код: seal_failed. Ключ и данные не изменены.",
};

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
      const result = await exportKey({ data: {} });
      if (!result.ok) {
        setMessage(Object.hasOwn(failureMessages, result.code) ? failureMessages[result.code] : "Контейнер не получен. Сервер вернул неизвестный результат; ключ и данные не изменены.");
        return;
      }
      let url: string | null = null;
      try {
        // The local receiver expects the unchanged envelope, not the RPC union.
        const envelope = result.envelope;
        url = URL.createObjectURL(new Blob([JSON.stringify(envelope)], { type: "application/json" }));
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = `umbra-key-transfer-${envelope.transferId}.json`;
        anchor.click();
        setMessage("Создан только зашифрованный контейнер; запрос скачивания передан браузеру. Проверьте сохранение файла. Исходный ключ, cookies и база не изменены; файл в чат не отправляйте.");
      } catch {
        setMessage("Сервер создал зашифрованный контейнер, но браузер не смог запустить скачивание. Код: download_failed. Ключ и данные не изменены.");
      } finally {
        if (url) { const pendingUrl = url; setTimeout(() => URL.revokeObjectURL(pendingUrl), 1000); }
      }
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
