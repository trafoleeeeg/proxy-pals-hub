import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { bulkUpdateProfiles, bulkDeleteProfiles } from "@/lib/profiles.functions";
import { transferProfiles } from "@/lib/folders.functions";
import { generateFingerprint } from "@/lib/fingerprint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProfileFingerprint } from "./profile-fingerprint";
import { fingerprintError, profileFingerprintPayload, splitTags, type ProfileChanges } from "./profile-model";

// Профили передаются только между папками: доступ сотрудника зависит от папки.
export type BulkAction = "edit" | "move" | "transfer" | "delete";
export function ProfileBulkDialog({ action, ids, teamId, isOwner, blocked, proxies, folders = [], onClose, onSaved }: {
  action: BulkAction; ids: string[]; teamId: string; isOwner: boolean; blocked: boolean;
  proxies: { id: string; label: string }[]; folders?: string[]; onClose: () => void; onSaved: () => void;
}) {
  const updateFn = useServerFn(bulkUpdateProfiles);
  const deleteFn = useServerFn(bulkDeleteProfiles);
  const transferFn = useServerFn(transferProfiles);
  const [fields, setFields] = useState<string[]>(action === "move" ? ["folder"] : []);
  const [folder, setFolder] = useState("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const [proxyId, setProxyId] = useState("none");
  const [fingerprint, setFingerprint] = useState(() => generateFingerprint());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = isOwner && ids.length > 0 && ids.length <= 200 && !busy && !blocked;

  async function submit() {
    if (!enabled) return;
    setBusy(true); setError(null);
    try {
      if (action === "delete") await deleteFn({ data: { teamId, ids } });
      else if (action === "transfer") {
        const target = folder.trim();
        if (!target) return;
        await transferFn({ data: { teamId, profileIds: ids, folder: target } });
      } else {
        const changes: ProfileChanges = {};
        if (fields.includes("folder")) changes.folder = folder;
        if (fields.includes("tags")) changes.tags = splitTags(tags);
        if (fields.includes("notes")) changes.notes = notes;
        if (fields.includes("proxyId")) changes.proxyId = proxyId === "none" ? null : proxyId;
        if (fields.includes("fingerprint")) {
          if (fingerprintError(fingerprint)) return;
          changes.fingerprint = profileFingerprintPayload(fingerprint);
        }
        if (!Object.keys(changes).length) return;
        await updateFn({ data: { teamId, ids, changes } });
      }
      onSaved(); onClose();
    } catch { setError("Операция не выполнена. Проверьте права, блокировки профилей и подключение; затем обновите список."); }
    finally { setBusy(false); }
  }
  const titles = { edit: "Изменить выбранные профили", move: "Перенести в папку", transfer: "Передать профили в папку", delete: "Удалить выбранные профили?" };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><DialogContent role={action === "delete" ? "alertdialog" : "dialog"} className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-xl">
    <DialogHeader className="min-w-0 pr-5"><DialogTitle className="break-words leading-snug tracking-normal">{titles[action]}</DialogTitle><DialogDescription>{action === "delete" ? `Будут удалены профили (${ids.length}), их облачные cookies и доступы сотрудников. Отменить удаление нельзя.` : `Выбрано профилей: ${ids.length}`}</DialogDescription></DialogHeader>
    {ids.length > 200 && <p role="alert" className="text-sm text-destructive">За одну операцию можно изменить до 200 профилей. Уменьшите выбор.</p>}
    {blocked && action !== "access" && <p role="alert" className="text-sm text-warning">Сначала закройте выбранные профили и завершите синхронизацию.</p>}
    {action === "transfer" ? <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Профили переедут в указанную папку, а выбранный сотрудник получит к ним доступ. Прежний доступ сохраняется.</p>
      <Input aria-label="Папка назначения" placeholder="Папка назначения (необязательно)" value={folder} disabled={!enabled} onChange={(e) => setFolder(e.target.value)} />
      {members.isPending && <p role="status" className="text-sm text-muted-foreground">Загрузка сотрудников…</p>}
      {members.isError && <p role="alert" className="text-sm text-destructive">Не удалось загрузить сотрудников. <Button size="sm" variant="ghost" onClick={() => members.refetch()}>Повторить</Button></p>}
      <Select value={userId} disabled={!enabled || members.isPending || members.isError} onValueChange={setUserId}><SelectTrigger aria-label="Сотрудник"><SelectValue placeholder="Сотрудник (необязательно)" /></SelectTrigger><SelectContent>{(members.data?.members ?? []).filter((member) => member.role === "member").map((member) => <SelectItem key={member.userId} value={member.userId}>{member.email}</SelectItem>)}</SelectContent></Select>
    </div> : action === "access" ? <div className="space-y-3">
      {members.isPending && <p role="status" className="text-sm text-muted-foreground">Загрузка сотрудников…</p>}
      {members.isError && <p role="alert" className="text-sm text-destructive">Не удалось загрузить сотрудников. <Button size="sm" variant="ghost" onClick={() => members.refetch()}>Повторить</Button></p>}
      <Select value={userId} disabled={!enabled || members.isPending || members.isError} onValueChange={setUserId}><SelectTrigger aria-label="Сотрудник"><SelectValue placeholder="Сотрудник" /></SelectTrigger><SelectContent>{(members.data?.members ?? []).filter((member) => member.role === "member").map((member) => <SelectItem key={member.userId} value={member.userId}>{member.email}</SelectItem>)}</SelectContent></Select>
      {!members.isPending && !members.isError && !members.data?.members.some((m) => m.role === "member") && <p className="text-sm text-muted-foreground">В команде пока нет сотрудников.</p>}
      <Select value={granted ? "grant" : "revoke"} disabled={!enabled} onValueChange={(v) => setGranted(v === "grant")}><SelectTrigger aria-label="Действие с доступом"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="grant">Предоставить доступ</SelectItem><SelectItem value="revoke">Отозвать доступ</SelectItem></SelectContent></Select>
    </div> : action !== "delete" && <fieldset disabled={!enabled} className="space-y-3">
      {(action === "move" ? ["folder"] : ["folder", "tags", "notes", "proxyId", "fingerprint"]).map((field) => {
        const labels: Record<string, string> = { folder: "Папка", tags: "Метки", notes: "Заметки", proxyId: "Прокси", fingerprint: "Отпечаток" };
        const active = fields.includes(field);
        return <div key={field} className="space-y-2">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={active} disabled={!enabled || action === "move"} onCheckedChange={(v) => setFields((current) => v === true ? [...current, field] : current.filter((key) => key !== field))} />{labels[field]}</label>
          {active && field === "folder" && <Input aria-label="Новая папка" placeholder="Без папки" value={folder} onChange={(e) => setFolder(e.target.value)} />}
          {active && field === "tags" && <Input aria-label="Новые метки через запятую" value={tags} onChange={(e) => setTags(e.target.value)} />}
          {active && field === "notes" && <Textarea aria-label="Новые заметки" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />}
          {active && field === "proxyId" && <Select value={proxyId} disabled={!enabled} onValueChange={setProxyId}><SelectTrigger aria-label="Новый прокси"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Без прокси</SelectItem>{proxies.map((proxy) => <SelectItem key={proxy.id} value={proxy.id}>{proxy.label}</SelectItem>)}</SelectContent></Select>}
          {active && field === "fingerprint" && <ProfileFingerprint value={fingerprint} onChange={setFingerprint} disabled={!enabled} />}
        </div>;
      })}
    </fieldset>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Отмена</Button><Button variant={action === "delete" ? "destructive" : "default"} disabled={!enabled || (action === "access" && (!userId || members.isError)) || (action === "transfer" && !folder.trim() && !userId) || ((action === "edit" || action === "move") && (!fields.length || (fields.includes("fingerprint") && !!fingerprintError(fingerprint))))} onClick={submit}>{busy ? "Выполняется…" : action === "delete" ? `Удалить ${ids.length}` : "Применить"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
