import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, pointerWithin, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { createContext, forwardRef, useCallback, useContext, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { toast } from "sonner";
import { reorderFolders, type FolderRow } from "@/lib/folders.functions";
import { bulkUpdateProfiles, reorderProfiles, type ProfileRow } from "@/lib/profiles.functions";
import { reorderProfileRows } from "@/lib/profile-order";
import { usePermissions } from "@/lib/usePermissions";
import { MAIN_FOLDER } from "@/lib/useProfileFolder";
import { useWorkspace } from "@/lib/useWorkspace";
import { TableRow } from "@/components/ui/table";

export const folderDragId = (id: string) => `folder:${id}`;
export const folderPageDragId = (id: string) => `folder-page:${id}`;
export const profileDragId = (id: string) => `profile:${id}`;

const detectDropTarget: CollisionDetection = (args) => {
  const pointerHits = args.pointerCoordinates ? pointerWithin(args) : [];
  if (args.active.data.current?.["kind"] !== "profile")
    return args.pointerCoordinates ? pointerHits : closestCenter(args);

  // A profile row also moves under the pointer. Using pointerWithin alone can
  // keep reporting the dragged row instead of the row underneath it.
  const folderHit = pointerHits.filter(({ id }) => String(id).startsWith("folder:") || String(id).startsWith("folder-page:"));
  if (folderHit.length) return folderHit;
  const profiles = args.droppableContainers.filter(({ id }) => String(id).startsWith("profile:") && id !== args.active.id);
  if (!profiles.length) return [];
  if (args.pointerCoordinates) {
    const rects = profiles.map(({ id }) => args.droppableRects.get(id)).filter((rect) => rect != null);
    const { x, y } = args.pointerCoordinates;
    if (!rects.length || x < Math.min(...rects.map((rect) => rect.left))
      || x > Math.max(...rects.map((rect) => rect.right))
      || y < Math.min(...rects.map((rect) => rect.top))
      || y > Math.max(...rects.map((rect) => rect.bottom))) return [];
  }
  return closestCenter({ ...args, droppableContainers: profiles });
};

type HandleProps = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners" | "setActivatorNodeRef"> & { disabled: boolean; name: string };
const DragHandleContext = createContext<HandleProps | null>(null);

export const ProfileDragRow = forwardRef<HTMLTableRowElement, { id: string; name: string; disabled: boolean } & ComponentProps<typeof TableRow>>(
  function ProfileDragRow({ id, name, disabled, children, ...props }, forwardedRef) {
    const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
      id: profileDragId(id), disabled: { draggable: disabled, droppable: false }, data: { label: name, kind: "profile" },
    });
    const setRefs = useCallback((node: HTMLTableRowElement | null) => {
      setNodeRef(node);
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    }, [setNodeRef, forwardedRef]);
    return <DragHandleContext.Provider value={{ attributes, listeners, setActivatorNodeRef, disabled, name }}>
      <TableRow {...props} ref={setRefs}
        className={`${props.className ?? ""} ${isDragging ? "opacity-35" : ""} ${isOver ? "bg-primary/10" : ""}`}
        style={{ ...props.style, transform: CSS.Transform.toString(transform), transition }}>{children}</TableRow>
    </DragHandleContext.Provider>;
});

export function ProfileDragHandle() {
  const handle = useContext(DragHandleContext);
  if (!handle || handle.disabled) return null;
  return <button type="button" ref={handle.setActivatorNodeRef} {...handle.attributes} {...handle.listeners}
    aria-label={`Перетащить профиль ${handle.name} вверх, вниз или в папку`}
    title="Перетащить профиль вверх, вниз или в другую папку"
    className="mr-1 inline-flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary active:cursor-grabbing"
    style={{ touchAction: "none" }}><GripVertical className="size-4" /></button>;
}

export function ProfileDndProvider({ children }: { children: ReactNode }) {
  const { data: ws } = useWorkspace();
  const { can } = usePermissions(ws?.teamId);
  const qc = useQueryClient();
  const reorder = useServerFn(reorderFolders);
  const reorderProfile = useServerFn(reorderProfiles);
  const moveProfile = useServerFn(bulkUpdateProfiles);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const reorderPending = useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function finish(event: DragEndEvent) {
    setActiveLabel(null);
    if (!ws || !event.over) return;
    const source = String(event.active.id);
    const target = String(event.over.id);
    if (source.startsWith("profile:") && target.startsWith("profile:") && can("profile.edit")) {
      if (event.delta.x === 0 && event.delta.y === 0) return;
      if (reorderPending.current) return;
      const key = ["profiles", ws.teamId];
      const previous = qc.getQueryData<ProfileRow[]>(key);
      if (!previous) return;
      const result = reorderProfileRows(previous, source.slice(8), target.slice(8));
      if (!result) return;
      reorderPending.current = true;
      qc.setQueryData(key, result.rows);
      try {
        await reorderProfile({ data: { teamId: ws.teamId, folder: result.folder || MAIN_FOLDER, ids: result.ids } });
      } catch (error) {
        qc.setQueryData(key, previous);
        toast.error(error instanceof Error ? error.message : "Не удалось изменить порядок профилей");
      } finally {
        reorderPending.current = false;
        void qc.invalidateQueries({ queryKey: key });
      }
      return;
    }
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

  return <DndContext sensors={sensors} collisionDetection={detectDropTarget}
    onDragStart={(event) => setActiveLabel(String(event.active.data.current?.["label"] ?? "Перемещение"))}
    onDragCancel={() => setActiveLabel(null)} onDragEnd={(event) => void finish(event)}>
    {children}
    <DragOverlay>{activeLabel && <div className="rounded-md border border-primary/60 bg-card px-3 py-2 text-sm font-medium shadow-xl">{activeLabel}</div>}</DragOverlay>
  </DndContext>;
}

