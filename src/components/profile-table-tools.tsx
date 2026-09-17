import { useState } from "react";
import { Columns3, Plus, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type ProfileStatus = { id: string; name: string; color: string; position: number };
export type ProfileField = { id: string; name: string; field_type: string; position: number };
export type FixedColumn = "folder" | "status" | "proxy" | "tags" | "notes" | "fingerprint" | "updated" | "created";

const fixedLabels: Record<FixedColumn, string> = {
  folder: "Папка", status: "Статус", proxy: "Прокси", tags: "Метки", notes: "Заметки",
  fingerprint: "Отпечаток", updated: "Изменён", created: "Создан",
};

export function ColumnSettings({ visible, onChange, fields }: {
  visible: FixedColumn[]; onChange: (value: FixedColumn[]) => void; fields: ProfileField[];
}) {
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="icon" title="Настроить колонки" aria-label="Настроить колонки"><Columns3 /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-56"><DropdownMenuLabel>Колонки таблицы</DropdownMenuLabel><DropdownMenuSeparator />
      {(Object.keys(fixedLabels) as FixedColumn[]).map((key) => <DropdownMenuCheckboxItem key={key} checked={visible.includes(key)} onSelect={(event) => event.preventDefault()} onCheckedChange={(checked) => onChange(checked ? [...visible, key] : visible.filter((item) => item !== key))}>{fixedLabels[key]}</DropdownMenuCheckboxItem>)}
      {!!fields.length && <><DropdownMenuSeparator /><DropdownMenuLabel>Дополнительные</DropdownMenuLabel>{fields.map((field) => <DropdownMenuCheckboxItem key={field.id} checked disabled>{field.name}</DropdownMenuCheckboxItem>)}</>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function MetadataManager({ open, onClose, statuses, fields, busy, onAddStatus, onAddField }: {
  open: boolean; onClose: () => void; statuses: ProfileStatus[]; fields: ProfileField[]; busy: boolean;
  onAddStatus: (name: string, color: string) => Promise<void>; onAddField: (name: string, type: string) => Promise<void>;
}) {
  const [statusName, setStatusName] = useState("");
  const [statusColor, setStatusColor] = useState("primary");
  const [fieldName, setFieldName] = useState("");
  const [fieldType, setFieldType] = useState("text");
  return <Dialog open={open} onOpenChange={(value) => { if (!value && !busy) onClose(); }}><DialogContent className="w-[calc(100%-2rem)] sm:max-w-lg">
    <DialogHeader><DialogTitle>Поля профилей</DialogTitle><DialogDescription>Статусы и дополнительные колонки общие для всей команды.</DialogDescription></DialogHeader>
    <div className="space-y-5">
      <section className="space-y-2"><h3 className="text-sm font-medium">Статусы</h3><div className="flex flex-wrap gap-2">{statuses.map((status) => <span key={status.id} className="rounded-md border border-border bg-secondary px-2 py-1 text-xs">{status.name}</span>)}{!statuses.length && <span className="text-xs text-muted-foreground">Статусов пока нет</span>}</div>
        <div className="grid grid-cols-[1fr_9rem_auto] gap-2"><Input aria-label="Название статуса" placeholder="Например, Готов" value={statusName} maxLength={80} onChange={(event) => setStatusName(event.target.value)} /><Select value={statusColor} onValueChange={setStatusColor}><SelectTrigger aria-label="Цвет статуса"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="primary">Фиолетовый</SelectItem><SelectItem value="success">Зелёный</SelectItem><SelectItem value="warning">Жёлтый</SelectItem><SelectItem value="destructive">Красный</SelectItem><SelectItem value="muted">Серый</SelectItem></SelectContent></Select><Button size="icon" aria-label="Добавить статус" disabled={busy || !statusName.trim()} onClick={() => void onAddStatus(statusName, statusColor).then(() => setStatusName(""))}><Plus /></Button></div>
      </section>
      <section className="space-y-2 border-t border-border pt-4"><h3 className="text-sm font-medium">Дополнительные колонки</h3><div className="space-y-1">{fields.map((field) => <div key={field.id} className="flex items-center gap-2 text-sm"><Tag className="size-3 text-muted-foreground" />{field.name}<span className="ml-auto text-xs text-muted-foreground">{field.field_type === "text" ? "Текст" : field.field_type === "number" ? "Число" : field.field_type === "date" ? "Дата" : "Ссылка"}</span></div>)}{!fields.length && <span className="text-xs text-muted-foreground">Дополнительных колонок пока нет</span>}</div>
        <div className="grid grid-cols-[1fr_8rem_auto] gap-2"><Input aria-label="Название колонки" placeholder="Например, Аккаунт" value={fieldName} maxLength={80} onChange={(event) => setFieldName(event.target.value)} /><Select value={fieldType} onValueChange={setFieldType}><SelectTrigger aria-label="Тип колонки"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="text">Текст</SelectItem><SelectItem value="number">Число</SelectItem><SelectItem value="date">Дата</SelectItem><SelectItem value="url">Ссылка</SelectItem></SelectContent></Select><Button size="icon" aria-label="Добавить колонку" disabled={busy || !fieldName.trim()} onClick={() => void onAddField(fieldName, fieldType).then(() => setFieldName(""))}><Plus /></Button></div>
      </section>
    </div>
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Готово</Button></DialogFooter>
  </DialogContent></Dialog>;
}

export function InlineText({ value, placeholder, disabled, multiline = false, onSave }: {
  value: string; placeholder: string; disabled: boolean; multiline?: boolean; onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => { if (draft !== value) onSave(draft); };
  return multiline
    ? <textarea aria-label={placeholder} rows={2} disabled={disabled} value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onBlur={commit} className="min-h-12 w-full resize-none rounded-sm border border-transparent bg-transparent px-1.5 py-1 text-xs outline-none placeholder:text-muted-foreground hover:border-border focus:border-input focus:bg-background" />
    : <Input aria-label={placeholder} disabled={disabled} value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onBlur={commit} className="h-7 min-w-28 border-transparent bg-transparent px-1.5 text-xs shadow-none hover:border-border focus:border-input focus:bg-background" />;
}