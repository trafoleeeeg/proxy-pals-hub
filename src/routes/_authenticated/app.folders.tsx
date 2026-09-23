import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { folderPageDragId } from "@/components/profile-dnd";
import { useWorkspace } from "@/lib/useWorkspace";
import { usePermissions } from "@/lib/usePermissions";
import { MAIN_FOLDER, useProfileFolder } from "@/lib/useProfileFolder";
import { createFolder, deleteFolder, listFolderAccess, listFolders, renameFolder, setFolderAccess, type FolderRow } from "@/lib/folders.functions";
import { listMembers } from "@/lib/team.functions";

export const Route = createFileRoute("/_authenticated/app/folders")({ component: FoldersPage });

function FolderPageRow({ row, movable, children }: { row: FolderRow; movable: boolean; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: folderPageDragId(row.id), disabled: { draggable: !movable, droppable: false }, data: { label: row.name, kind: "folder" },
  });
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
    className={"flex items-center gap-2 p-3 " + (isDragging ? "opacity-35" : "") + (isOver ? " ring-2 ring-inset ring-primary" : "")}>
    {movable ? <button type="button" {...attributes} {...listeners} title="Перетащить папку" aria-label={`Перетащить папку ${row.name}`}
      className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-accent active:cursor-grabbing"
      style={{ touchAction: "none" }}><GripVertical className="size-4" /></button> : <span className="w-6 shrink-0" />}
    {children}
  </div>;
}

export function FoldersPage() {
  const { data: ws } = useWorkspace();
  const { can } = usePermissions(ws?.teamId);
  const { folder: selectedFolder, setFolder } = useProfileFolder();
  const qc = useQueryClient();
  const listFn = useServerFn(listFolders);
  const membersFn = useServerFn(listMembers);
  const accessFn = useServerFn(listFolderAccess);
  const createFn = useServerFn(createFolder);
  const renameFn = useServerFn(renameFolder);
  const deleteFn = useServerFn(deleteFolder);
  const setAccessFn = useServerFn(setFolderAccess);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const folders = useQuery({ queryKey: ["folders", ws?.teamId], queryFn: () => listFn({ data: { teamId: ws!.teamId } }), enabled: !!ws });
  const members = useQuery({ queryKey: ["team", ws?.teamId], queryFn: () => membersFn({ data: { teamId: ws!.teamId } }), enabled: !!ws?.canManage });
  const access = useQuery({ queryKey: ["folder-access", ws?.teamId], queryFn: () => accessFn({ data: { teamId: ws!.teamId } }), enabled: !!ws?.canManage });
  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey: ["folders"] }), qc.invalidateQueries({ queryKey: ["profiles"] }), qc.invalidateQueries({ queryKey: ["folder-access"] })]); };
  const mutate = useMutation({ mutationFn: async (action: () => Promise<unknown>) => action(), onSuccess: refresh, onError: (error: Error) => toast.error(error.message) });
  const rows = folders.data ?? [];
  const people = (members.data?.members ?? []).filter((row) => row.role === "member");
  const granted = new Set((access.data ?? []).map((row) => `${row.folder}:${row.userId}`));
  const accessRows = rows.filter((row) => !row.isDefault).map((row) => ({ id: row.id, name: row.name, folder: row.name }));

  function saveRename(row: FolderRow) {
    if (!ws || !draftName.trim() || mutate.isPending) return;
    const next = draftName.trim();
    mutate.mutate(() => renameFn({ data: { teamId: ws.teamId, id: row.id, name: next } }), {
      onSuccess: () => { if (selectedFolder === row.name) setFolder(next); setEditingId(null); },
    });
  }

  function removeFolder(row: FolderRow) {
    if (!ws || !window.confirm(`Удалить папку «${row.name}»? Профили перейдут в личную Основную.`)) return;
    mutate.mutate(() => deleteFn({ data: { teamId: ws.teamId, id: row.id } }), {
      onSuccess: () => { if (selectedFolder === row.name) setFolder(MAIN_FOLDER); },
    });
  }

  if (!ws) return <p role="status">Загрузка папок…</p>;
  return <div className="max-w-5xl space-y-5">
    <div><h1 className="text-2xl font-semibold">Папки</h1><p className="mt-1 text-sm text-muted-foreground">«Основная» — личная папка владельца. Остальные папки можно открыть сотрудникам. Порядок меняется перетаскиванием.</p></div>
    {can("folder.manage") && <div className="flex flex-wrap gap-2"><Input className="max-w-xs" aria-label="Название новой папки" placeholder="Название новой папки" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) { mutate.mutate(() => createFn({ data: { teamId: ws.teamId, name: name.trim() } })); setName(""); } }} /><Button disabled={!name.trim() || mutate.isPending} onClick={() => { mutate.mutate(() => createFn({ data: { teamId: ws.teamId, name: name.trim() } })); setName(""); }}>Создать</Button></div>}
    {folders.isError && <p role="alert" className="text-destructive">Не удалось загрузить папки. <Button variant="outline" onClick={() => folders.refetch()}>Повторить</Button></p>}
    <div className="divide-y rounded-lg border border-border bg-card">
      <SortableContext items={rows.map((row) => folderPageDragId(row.id))} strategy={verticalListSortingStrategy}>
      {rows.map((row) => <FolderPageRow key={row.id} row={row} movable={can("folder.manage") && !row.isDefault && !row.virtual}>
        {editingId === row.id ? <Input autoFocus aria-label={`Новое название папки ${row.name}`} className="min-w-0 flex-1" value={draftName} maxLength={200} onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveRename(row); if (event.key === "Escape") setEditingId(null); }} /> : <span className="min-w-0 flex-1 truncate text-sm">{row.name}{row.isDefault && <span className="ml-2 text-xs text-muted-foreground">личная, не делится</span>}{row.virtual && <span className="ml-2 text-xs text-muted-foreground">из профилей</span>}</span>}
        {can("folder.manage") && !row.isDefault && !row.virtual && (editingId === row.id ? <><Button variant="outline" size="sm" disabled={mutate.isPending || !draftName.trim()} onClick={() => saveRename(row)}>Сохранить</Button><Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>Отмена</Button></> : <><Button variant="ghost" size="sm" disabled={mutate.isPending} onClick={() => { setDraftName(row.name); setEditingId(row.id); }}><Pencil className="size-4" />Переименовать</Button><Button variant="ghost" size="sm" disabled={mutate.isPending} onClick={() => removeFolder(row)}><Trash2 className="size-4" />Удалить</Button></>)}
      </FolderPageRow>)}
      </SortableContext>
    </div>
    {ws.canManage && <section className="space-y-2"><h2 className="text-lg font-semibold">Доступ сотрудников к папкам</h2><p className="text-sm text-muted-foreground">Основная остаётся личной. Доступ выдаётся только к созданным папкам и всем профилям внутри них.</p><div className="overflow-x-auto rounded-lg border border-border bg-card"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-3 text-left">Папка</th>{people.map((person) => <th key={person.userId} className="p-3 text-center">{person.email}</th>)}</tr></thead><tbody>{accessRows.map((row) => <tr key={row.id} className="border-b last:border-0"><td className="p-3">{row.name}</td>{people.map((person) => <td key={person.userId} className="p-3 text-center"><Checkbox aria-label={`Доступ ${person.email} к папке ${row.name}`} checked={granted.has(`${row.folder}:${person.userId}`)} disabled={mutate.isPending} onCheckedChange={(value) => mutate.mutate(() => setAccessFn({ data: { teamId: ws.teamId, folder: row.folder, userId: person.userId, granted: value === true } }))} /></td>)}</tr>)}</tbody></table></div></section>}
  </div>;
}
