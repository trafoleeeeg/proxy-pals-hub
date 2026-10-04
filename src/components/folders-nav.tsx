import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Folder, FolderCog, GripVertical, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { folderDragId } from "@/components/profile-dnd";
import { deleteFolder, listFolders, renameFolder, type FolderRow } from "@/lib/folders.functions";
import { listProfiles } from "@/lib/profiles.functions";
import { MAIN_FOLDER, useProfileFolder } from "@/lib/useProfileFolder";
import { usePermissions } from "@/lib/usePermissions";
import { useWorkspace } from "@/lib/useWorkspace";

function MainFolder({ collapsed, count, selected, select }: { collapsed: boolean; count: number; selected: boolean; select: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: folderDragId("main") });
  return <Button ref={setNodeRef} variant={selected ? "secondary" : "ghost"} title="Основная — личная папка" aria-label="Папка Основная"
    aria-pressed={selected} className={"h-10 w-full gap-3 px-3 text-sm " + (collapsed ? "justify-center px-0" : "justify-start") + (isOver ? " ring-2 ring-primary" : "")}
    onClick={select}><LockKeyhole className="size-4 shrink-0 text-muted-foreground" />{!collapsed && <><span className="truncate">Основная</span><span className="ml-auto text-xs tabular-nums text-muted-foreground">{count}</span></>}</Button>;
}

function SharedFolder({ row, collapsed, count, selected, canManage, select, rename, remove }: {
  row: FolderRow; collapsed: boolean; count: number; selected: boolean; canManage: boolean;
  select: () => void; rename: () => void; remove: () => void;
}) {
  const movable = canManage && !row.virtual;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: folderDragId(row.id), disabled: { draggable: !movable, droppable: false }, data: { label: row.name, kind: "folder" },
  });
  return <ContextMenu><ContextMenuTrigger asChild><Button ref={setNodeRef}
    variant={selected ? "secondary" : "ghost"} title={row.name} aria-label={`Папка ${row.name}`}
    style={{ transform: CSS.Transform.toString(transform), transition }}
    aria-pressed={selected} className={"group h-10 w-full gap-3 px-3 text-sm " + (collapsed ? "justify-center px-0" : "justify-start") + (isDragging ? " opacity-35" : "") + (isOver ? " ring-2 ring-primary" : "")}
    onClick={select}>
    {movable && !collapsed ? <span {...attributes} {...listeners} aria-label={`Перетащить папку ${row.name}`}
      className="relative flex size-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing" style={{ touchAction: "none" }}><Folder className="absolute size-4 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0" /><GripVertical className="size-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" /></span>
      : <Folder className="size-4 shrink-0 text-muted-foreground" />}
    {!collapsed && <><span className="truncate">{row.name}</span><span className="ml-auto text-xs tabular-nums text-muted-foreground">{count}</span></>}
  </Button></ContextMenuTrigger><ContextMenuContent>
    <ContextMenuItem onSelect={select}>Открыть</ContextMenuItem>
    {movable && <><ContextMenuItem onSelect={rename}>Переименовать</ContextMenuItem><ContextMenuItem onSelect={remove}>Удалить</ContextMenuItem></>}
  </ContextMenuContent></ContextMenu>;
}

export function FoldersNav({ collapsed = false }: { collapsed?: boolean }) {
  const { data: ws } = useWorkspace();
  const { can } = usePermissions(ws?.teamId);
  const { folder, setFolder } = useProfileFolder();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const qc = useQueryClient();
  const listFn = useServerFn(listProfiles);
  const foldersFn = useServerFn(listFolders);
  const renameFn = useServerFn(renameFolder);
  const deleteFn = useServerFn(deleteFolder);
  const [editing, setEditing] = useState<FolderRow | null>(null);
  const [draftName, setDraftName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const profiles = useQuery({ queryKey: ["profiles", ws?.teamId], queryFn: () => listFn({ data: { teamId: ws!.teamId } }), enabled: !!ws });
  const folders = useQuery({ queryKey: ["folders", ws?.teamId], queryFn: () => foldersFn({ data: { teamId: ws!.teamId } }), enabled: !!ws });
  const shared = (folders.data ?? []).filter((row) => !row.isDefault);
  const count = (name: string) => (profiles.data ?? []).filter((profile) => profile.folder === name || (name === MAIN_FOLDER && !profile.folder)).length;
  const select = (name: string) => { setFolder(name); void navigate({ to: "/app" }); };
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["folders"] }); void qc.invalidateQueries({ queryKey: ["profiles"] }); };
  const rename = (row: FolderRow) => { setEditing(row); setDraftName(row.name); };
  async function saveRename() {
    const name = draftName.trim();
    if (!ws || !editing || !name || renaming) return;
    if (name === editing.name) { setEditing(null); return; }
    setRenaming(true);
    try {
      await renameFn({ data: { teamId: ws.teamId, id: editing.id, name } });
      if (folder === editing.name) setFolder(name);
      setEditing(null);
      refresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось переименовать папку"); }
    finally { setRenaming(false); }
  }
  const remove = (row: FolderRow) => {
    if (!ws || !window.confirm(`Удалить папку «${row.name}»? Профили перейдут в вашу Основную.`)) return;
    void deleteFn({ data: { teamId: ws.teamId, id: row.id } }).then(() => { if (folder === row.name) setFolder(MAIN_FOLDER); refresh(); }).catch((error: Error) => toast.error(error.message));
  };
  return <div className="mt-4 border-t border-sidebar-border/70 pt-3">
    <Link to="/app/folders" title="Управление папками" aria-label="Папки" aria-current={pathname === "/app/folders" ? "page" : undefined}
      className={"mb-1 flex items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground " + (collapsed ? "justify-center px-0" : "")}>
      <FolderCog className="size-4 shrink-0" />{!collapsed && "Папки"}
    </Link>
    <div className="flex flex-col gap-0.5">
      {ws?.scope === "owner" && <MainFolder collapsed={collapsed} count={count(MAIN_FOLDER)} selected={folder === MAIN_FOLDER} select={() => select(MAIN_FOLDER)} />}
      <SortableContext items={shared.map((row) => folderDragId(row.id))} strategy={verticalListSortingStrategy}>
        {shared.map((row) => <SharedFolder key={row.id} row={row} collapsed={collapsed} count={count(row.name)} selected={folder === row.name} canManage={can("folder.manage")} select={() => select(row.name)} rename={() => rename(row)} remove={() => remove(row)} />)}
      </SortableContext>
    </div>
    <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !renaming) setEditing(null); }}><DialogContent>
      <DialogHeader><DialogTitle>Переименовать папку</DialogTitle><DialogDescription>Профили и права сотрудников останутся в этой папке.</DialogDescription></DialogHeader>
      <Input autoFocus aria-label="Новое название папки" value={draftName} maxLength={200} disabled={renaming} onChange={(event) => setDraftName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveRename(); }} />
      <DialogFooter><Button variant="outline" disabled={renaming} onClick={() => setEditing(null)}>Отмена</Button><Button disabled={renaming || !draftName.trim()} onClick={() => void saveRename()}>{renaming ? "Сохранение…" : "Сохранить"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
