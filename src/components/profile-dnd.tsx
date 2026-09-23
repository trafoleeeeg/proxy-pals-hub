import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, useDraggable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { GripVertical } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { toast } from "sonner";
import { reorderFolders, type FolderRow } from "@/lib/folders.functions";
import { bulkUpdateProfiles } from "@/lib/profiles.functions";
import { usePermissions } from "@/lib/usePermissions";
import { MAIN_FOLDER } from "@/lib/useProfileFolder";
import { useWorkspace } from "@/lib/useWorkspace";
import { TableRow } from "@/components/ui/table";

export const folderDragId = (id: string) => `folder:${id}`;
export const folderPageDragId = (id: string) => `folder-page:${id}`;
export const profileDragId = (id: string) => `profile:${id}`;

export function ProfileDragRow({ id, name, disabled, children, ...props }: { id: string; name: string; disabled: boolean } & ComponentProps<typeof TableRow>) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: profileDragId(id), disabled, data: { label: name, kind: "profile" },
  });
  return <TableRow ref={setNodeRef} {...props} {...attributes} {...listeners}
    aria-label={`Профиль ${name}. Зажмите строку и перенесите в папку`}
    className={`${props.className ?? ""} ${disabled ? "" : "cursor-grab active:cursor-grabbing"} ${isDragging ? "opacity-35" : ""}`}
    style={{ ...props.style, touchAction: "pan-y" }}>{children}</TableRow>;
}

export function ProfileDragHandle() {
  return <span aria-hidden="true" className="mr-1 inline-flex size-6 shrink-0 items-center justify-center text-muted-foreground"><GripVertical className="size-4" /></span>;
}

export function ProfileDndProvider({ children }: { children: ReactNode }) {
  const { data: ws } = useWorkspace();
  const { can } = usePermissions(ws?.teamId);
  const qc = useQueryClient();
  const reorder = useServerFn(reorderFolders);
  const moveProfile = useServerFn(bulkUpdateProfiles);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function finish(event: DragEndEvent) {
    setActiveLabel(null);
    if (!ws || !event.over) return;
    const source = String(event.active.id);
    const target = String(event.over.id);
    if (!target.startsWith("folder:") && !target.startsWith("folder-page:")) return;
    const folderId = target.startsWith("folder-page:") ? target.slice(12) : target.slice(7);
    const key = ["folders", ws.teamId];
    const rows = qc.getQueryData<FolderRow[]>(key) ?? [];
    if ((source.startsWith("folder:") || source.startsWith("folder-page:")) && can("folder.manage")) {
      const movable = rows.filter((row) => !row.isDefault && !row.virtual);
      const sourceId = source.startsWith("folder-page:") ? source.slice(12) : source.slice(7);
      const from = movable.findIndex((row) => row.id === sourceId);
      const to = movable.findIndex((row) => row.id === folderId);
      if (from < 0 || to < 0 || from === to) return;
      const ordered = arrayMove(movable, from, to);
      qc.setQueryData<FolderRow[]>(key, [...rows.filter((row) => row.isDefault), ...ordered, ...rows.filter((row) => row.virtual)]);
      try { await reorder({ data: { teamId: ws.teamId, ids: ordered.map((row) => row.id) } }); }
      catch (error) { qc.setQueryData(key, rows); toast.error(error instanceof Error ? error.message : "Не удалось изменить порядок папок"); }
      finally { void qc.invalidateQueries({ queryKey: ["folders"] }); }
      return;
    }
    if (!source.startsWith("profile:") || !can("profile.edit")) return;
    const folder = folderId === "main" ? MAIN_FOLDER : rows.find((row) => row.id === folderId)?.name;
    if (!folder) return;
    try {
      await moveProfile({ data: { teamId: ws.teamId, ids: [source.slice(8)], changes: { folder } } });
      await qc.invalidateQueries({ queryKey: ["profiles"] });
      toast.success(`Профиль перенесён в «${folder}»`);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось перенести профиль"); }
  }

  return <DndContext sensors={sensors} collisionDetection={pointerWithin}
    onDragStart={(event) => setActiveLabel(String(event.active.data.current?.["label"] ?? "Перемещение"))}
    onDragCancel={() => setActiveLabel(null)} onDragEnd={(event) => void finish(event)}>
    {children}
    <DragOverlay>{activeLabel && <div className="rounded-md border border-primary/60 bg-card px-3 py-2 text-sm font-medium shadow-xl">{activeLabel}</div>}</DragOverlay>
  </DndContext>;
}
