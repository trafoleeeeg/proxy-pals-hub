import { useEffect, useRef, useState, type ReactNode } from "react";
import { ClipboardPaste, Columns3, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableHead } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

export type ProfileStatus = { id: string; name: string; color: string; position: number };
export type ProfileField = { id: string; name: string; field_type: string; position: number };
export type FixedColumn = "folder" | "status" | "proxy" | "notes" | "fingerprint" | "updated" | "created";

const fixedLabels: Record<FixedColumn, string> = {
  folder: "Папка", status: "Статус", proxy: "Прокси", notes: "Заметки",
  fingerprint: "Отпечаток", updated: "Изменён", created: "Создан",
};

export function ColumnSettings({ visible, onChange, fields, visibleFields, onFieldChange }: {
  visible: FixedColumn[]; onChange: (value: FixedColumn[]) => void; fields: ProfileField[];
  visibleFields: string[]; onFieldChange: (value: string[]) => void;
}) {
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="icon" title="Настроить колонки" aria-label="Настроить колонки"><Columns3 /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-56"><DropdownMenuLabel>Колонки таблицы</DropdownMenuLabel><DropdownMenuSeparator />
      {(Object.keys(fixedLabels) as FixedColumn[]).map((key) => <DropdownMenuCheckboxItem key={key} checked={visible.includes(key)} onSelect={(event) => event.preventDefault()} onCheckedChange={(checked) => onChange(checked ? [...visible, key] : visible.filter((item) => item !== key))}>{fixedLabels[key]}</DropdownMenuCheckboxItem>)}
      {!!fields.length && <><DropdownMenuSeparator /><DropdownMenuLabel>Дополнительные</DropdownMenuLabel>{fields.map((field) => <DropdownMenuCheckboxItem key={field.id} checked={visibleFields.includes(field.id)} onSelect={(event) => event.preventDefault()} onCheckedChange={(checked) => onFieldChange(checked ? [...visibleFields, field.id] : visibleFields.filter((id) => id !== field.id))}>{field.name}</DropdownMenuCheckboxItem>)}</>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function StatusEditorRow({ status, busy, onUpdate, onDelete }: {
  status: ProfileStatus; busy: boolean;
  onUpdate: (id: string, name: string, color: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(status.name);
  const [color, setColor] = useState(status.color);
  useEffect(() => { setName(status.name); setColor(status.color); }, [status.id, status.name, status.color]);
  const dirty = name.trim() !== status.name || color !== status.color;
  return <div className="grid grid-cols-[1fr_9rem_auto_auto] items-center gap-2">
    <Input aria-label={"Название статуса " + status.name} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
    <Select value={color} onValueChange={setColor}><SelectTrigger aria-label={"Цвет статуса " + status.name}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="primary">Фиолетовый</SelectItem><SelectItem value="success">Зелёный</SelectItem><SelectItem value="warning">Жёлтый</SelectItem><SelectItem value="destructive">Красный</SelectItem><SelectItem value="muted">Серый</SelectItem></SelectContent></Select>
    <Button size="icon" variant="outline" aria-label={"Сохранить статус " + status.name} disabled={busy || !dirty || !name.trim()} onClick={() => void onUpdate(status.id, name.trim(), color)}><Pencil /></Button>
    <Button size="icon" variant="outline" aria-label={"Удалить статус " + status.name} disabled={busy} onClick={() => { if (window.confirm(`Удалить статус «${status.name}»? Он пропадёт у всех профилей.`)) void onDelete(status.id); }}><Trash2 /></Button>
  </div>;
}

export function MetadataManager({ open, onClose, statuses, fields, busy, onAddStatus, onAddField, onUpdateStatus, onDeleteStatus }: {
  open: boolean; onClose: () => void; statuses: ProfileStatus[]; fields: ProfileField[]; busy: boolean;
  onAddStatus: (name: string, color: string) => Promise<void>; onAddField: (name: string, type: string) => Promise<void>;
  onUpdateStatus: (id: string, name: string, color: string) => Promise<void>;
  onDeleteStatus: (id: string) => Promise<void>;
}) {
  const [statusName, setStatusName] = useState("");
  const [statusColor, setStatusColor] = useState("primary");
  const [fieldName, setFieldName] = useState("");
  const [fieldType, setFieldType] = useState("text");
  return <Dialog open={open} onOpenChange={(value) => { if (!value && !busy) onClose(); }}><DialogContent className="w-[calc(100%-2rem)] sm:max-w-lg">
    <DialogHeader><DialogTitle>Поля профилей</DialogTitle><DialogDescription>Статусы и дополнительные колонки общие для всей команды.</DialogDescription></DialogHeader>
    <div className="space-y-5">
      <section className="space-y-2"><h3 className="text-sm font-medium">Статусы</h3>
        <div className="space-y-2">
          {statuses.map((status) => <StatusEditorRow key={status.id} status={status} busy={busy} onUpdate={onUpdateStatus} onDelete={onDeleteStatus} />)}
          {!statuses.length && <span className="text-xs text-muted-foreground">Статусов пока нет</span>}
        </div>
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
const WIDTH_KEY = "umbra:column-widths";
const MIN_WIDTH = 60;
const MAX_WIDTH = 640;

// Column widths are personal, so they live in the browser of each user.
export function useColumnWidths() {
  const [widths, setWidths] = useState<Record<string, number>>({});
  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(WIDTH_KEY) || "{}") as Record<string, unknown>;
      const clean: Record<string, number> = {};
      for (const [key, value] of Object.entries(stored)) {
        if (typeof value === "number" && value >= MIN_WIDTH && value <= MAX_WIDTH) clean[key] = value;
      }
      setWidths(clean);
    } catch { /* an unreadable setting falls back to default widths */ }
  }, []);
  const setWidth = (key: string, width: number) => {
    setWidths((current) => {
      const next = { ...current, [key]: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width))) };
      try { window.localStorage.setItem(WIDTH_KEY, JSON.stringify(next)); } catch { /* storage may be unavailable */ }
      return next;
    });
  };
  const reset = () => { setWidths({}); try { window.localStorage.removeItem(WIDTH_KEY); } catch { /* ignore */ } };
  return { widths, setWidth, reset };
}

export function ResizableHead({ columnKey, widths, setWidth, className, children }: {
  columnKey: string; widths: Record<string, number>; setWidth: (key: string, width: number) => void;
  className?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLTableCellElement>(null);
  const width = widths[columnKey];
  function drag(startX: number, startWidth: number) {
    const move = (event: PointerEvent) => setWidth(columnKey, startWidth + event.clientX - startX);
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }
  return <TableHead ref={ref} className={"relative " + (className ?? "")} style={width ? { width, minWidth: width, maxWidth: width } : undefined}>
    <span className="block truncate pr-2">{children}</span>
    <span role="separator" aria-label="Изменить ширину колонки" tabIndex={0}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none bg-transparent hover:bg-primary/40"
      onPointerDown={(event) => { event.preventDefault(); drag(event.clientX, ref.current?.getBoundingClientRect().width ?? MIN_WIDTH); }}
      onKeyDown={(event) => {
        const current = ref.current?.getBoundingClientRect().width ?? MIN_WIDTH;
        if (event.key === "ArrowLeft") { event.preventDefault(); setWidth(columnKey, current - 16); }
        if (event.key === "ArrowRight") { event.preventDefault(); setWidth(columnKey, current + 16); }
      }} />
  </TableHead>;
}

export function NotesCell({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [pasteError, setPasteError] = useState(false);
  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      setDraft((current) => (current ? current + "\n" : "") + text);
      setPasteError(false);
    } catch { setPasteError(true); }
  }
  return <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) { setDraft(value); setPasteError(false); } }}>
      <PopoverTrigger asChild><button type="button" disabled={disabled} title={value || "Открыть заметку"}
        aria-label={`Открыть заметку: ${value || "пусто"}`}
        className="flex w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default">
        <span className="min-w-0 flex-1 truncate">{value || "—"}</span><Pencil className="size-3.5 shrink-0" />
      </button></PopoverTrigger>
      <PopoverContent align="end" className="w-[min(42rem,calc(100vw-2rem))] space-y-3 p-4">
        <p className="text-sm font-medium">Заметка профиля</p>
        <Textarea aria-label="Заметка профиля" rows={12} value={draft} placeholder="Заметка" onChange={(event) => setDraft(event.target.value)} className="min-h-64 resize-y text-sm" />
        {pasteError && <p role="alert" className="text-xs text-destructive">Буфер обмена недоступен. Вставьте текст сочетанием клавиш.</p>}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void paste()}><ClipboardPaste className="size-4" />Вставить</Button>
          <Button size="sm" className="ml-auto" onClick={() => { if (draft !== value) onSave(draft); setOpen(false); }}>Сохранить</Button>
        </div>
      </PopoverContent>
    </Popover>;
}

export const statusTone: Record<string, string> = {
  primary: "border-primary/50 bg-primary/10 text-primary",
  success: "border-success/50 bg-success/10 text-success",
  warning: "border-warning/50 bg-warning/10 text-warning",
  destructive: "border-destructive/50 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
};
const colorNames: Array<{ value: string; label: string }> = [
  { value: "success", label: "Зелёный" }, { value: "destructive", label: "Красный" },
  { value: "warning", label: "Жёлтый" }, { value: "primary", label: "Фиолетовый" }, { value: "muted", label: "Серый" },
];

export function StatusCell({ statusId, statuses, disabled, canCreate, onSelect, onCreate }: {
  statusId: string | null; statuses: ProfileStatus[]; disabled: boolean; canCreate: boolean;
  onSelect: (statusId: string | null) => void; onCreate: (name: string, color: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("success");
  const [saving, setSaving] = useState(false);
  const current = statuses.find((status) => status.id === statusId);
  const chip = "inline-flex max-w-full items-center truncate rounded-md border px-2 py-0.5 text-xs font-medium";
  async function create() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try { await onCreate(name.trim(), color); setName(""); } finally { setSaving(false); }
  }
  return <Popover open={open} onOpenChange={(next) => { if (!disabled || !next) setOpen(next); }}>
    <PopoverTrigger asChild>
      <button type="button" disabled={disabled} aria-label="Статус профиля"
        className={`${chip} ${current ? statusTone[current.color] ?? statusTone["muted"] : "border-border bg-secondary text-muted-foreground"} disabled:opacity-60`}>
        {current ? current.name : "Без статуса"}
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-56 space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={`${chip} border-border bg-secondary text-muted-foreground`} onClick={() => { onSelect(null); setOpen(false); }}>Без статуса</button>
        {statuses.map((status) => <button key={status.id} type="button" className={`${chip} ${statusTone[status.color] ?? statusTone["muted"]}`} onClick={() => { onSelect(status.id); setOpen(false); }}>{status.name}</button>)}
      </div>
      {canCreate && <div className="space-y-2 border-t border-border pt-2">
        <Input aria-label="Новый статус" placeholder="Новый статус" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
        <div className="flex gap-2">
          <Select value={color} onValueChange={setColor}><SelectTrigger aria-label="Цвет статуса" className="h-8 flex-1 text-xs"><SelectValue /></SelectTrigger><SelectContent>{colorNames.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select>
          <Button size="sm" disabled={saving || !name.trim()} onClick={() => void create()}>Создать</Button>
        </div>
      </div>}
    </PopoverContent>
  </Popover>;
}
