import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useNavigate } from "@tanstack/react-router";
import { Archive, BriefcaseBusiness, Folder, FolderOpen, Globe2, ShoppingBag, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { bulkUpdateProfiles, listProfiles } from "@/lib/profiles.functions";
import { deleteFolder, listFolders, renameFolder, reorderFolders } from "@/lib/folders.functions";
import { useWorkspace } from "@/lib/useWorkspace";
import { ALL_FOLDERS, useProfileFolder } from "@/lib/useProfileFolder";
import { usePermissions } from "@/lib/usePermissions";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";

const icons = [Folder, BriefcaseBusiness, ShoppingBag, UsersRound, Globe2];

export function FoldersNav({ collapsed = false }: { collapsed?: boolean }) {
  const { data: ws } = useWorkspace();
  const listFn = useServerFn(listProfiles);
  const foldersFn = useServerFn(listFolders);
  const renameFn = useServerFn(renameFolder);
  const deleteFn = useServerFn(deleteFolder);
  const reorderFn = useServerFn(reorderFolders);
  const moveFn = useServerFn(bulkUpdateProfiles);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = usePermissions(ws?.teamId);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const { folder, setFolder } = useProfileFolder();
  const profiles = useQuery({
    queryKey: ["profiles", ws?.teamId],
    queryFn: () => { if (!ws) throw new Error("Команда не загружена"); return listFn({ data: { teamId: ws.teamId } }); },
    enabled: !!ws,
  });
  const folders = useQuery({
    queryKey: ["folders", ws?.teamId],
    queryFn: () => { if (!ws) throw new Error("Команда не загружена"); return foldersFn({ data: { teamId: ws.teamId } }); },
    enabled: !!ws,
  });
  const items = useMemo(() => {
    const known = (folders.data ?? []);
    return [...new Set([...known.map((row) => row.name), ...(profiles.data ?? []).map((p) => p.folder).filter(Boolean)])];
  }, [folders.data, profiles.data]);
  const count = (name: string) => (profiles.data ?? []).filter((profile) => profile.folder === name).length;
  const row = (active: boolean) => "h-8 w-full gap-3 px-2 text-xs " + (collapsed ? "justify-center " : "justify-start ") + (active ? "" : "text-muted-foreground");
  const label = (text: string, value: number) => collapsed ? null : <><span className="truncate">{text}</span><span className="ml-auto tabular-nums text-muted-foreground">{value}</span></>;
  const select = (value: string) => { setFolder(value); void navigate({ to: "/app" }); };
  async function dropProfile(event: React.DragEvent, target: string) {
    event.preventDefault(); setDropTarget(null);
    const draggedFolder = event.dataTransfer.getData("application/x-umbra-folder");
    if (draggedFolder && ws && can("folder.manage")) {
      const movable = (folders.data ?? []).filter((row) => !row.isDefault && !row.virtual);
      const source = movable.findIndex((row) => row.id === draggedFolder);
      const destination = movable.findIndex((row) => row.name === target);
      if (source < 0 || destination < 0 || source === destination) return;
      const [moved] = movable.splice(source, 1);
      if (!moved) return;
      movable.splice(destination, 0, moved);
      try { await reorderFn({ data: { teamId: ws.teamId, ids: movable.map((row) => row.id) } }); await qc.invalidateQueries({ queryKey: ["folders"] }); }
      catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось изменить порядок папок"); }
      return;
    }
    const id = event.dataTransfer.getData("application/x-umbra-profile");
    if (!id || !ws || !can("profile.edit")) return;
    try { await moveFn({ data: { teamId: ws.teamId, ids: [id], changes: { folder: target } } }); await qc.invalidateQueries({ queryKey: ["profiles"] }); toast.success(`Профиль перенесён в «${target || "Без папки"}»`); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось перенести профиль"); }
  }
  const dropProps = (target: string, reorderable = false) => ({ onDragOver: (event: React.DragEvent) => { if (event.dataTransfer.types.includes("application/x-umbra-profile") || (reorderable && event.dataTransfer.types.includes("application/x-umbra-folder"))) { event.preventDefault(); setDropTarget(target); } }, onDragLeave: () => setDropTarget(null), onDrop: (event: React.DragEvent) => void dropProfile(event, target) });
  return <div className="mt-2 border-t border-sidebar-border pt-2">
    {!collapsed && <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Папки</p>}
    <div className="flex flex-col gap-0.5">
      <Button variant={folder === ALL_FOLDERS ? "secondary" : "ghost"} title="Все профили" aria-label="Все профили" className={row(folder === ALL_FOLDERS)} onClick={() => select(ALL_FOLDERS)}>
        <FolderOpen className="size-4 shrink-0 text-primary" />{label("Все профили", profiles.data?.length ?? 0)}
      </Button>
      <Button {...dropProps("")} variant={folder === "" ? "secondary" : "ghost"} title="Без папки" aria-label="Без папки" className={row(folder === "") + (dropTarget === "" ? " ring-2 ring-primary" : "")} onClick={() => select("")}>
        <Archive className="size-4 shrink-0 text-warning" />{label("Без папки", count(""))}
      </Button>
      {items.map((item, index) => {
        const Icon = icons[index % icons.length] ?? Folder;
        const record = folders.data?.find((entry) => entry.name === item);
        return <ContextMenu key={item}><ContextMenuTrigger asChild><Button {...dropProps(item, !!record && !record.isDefault && !record.virtual)} draggable={can("folder.manage") && !!record && !record.isDefault && !record.virtual} onDragStart={(event) => { if (record) { event.dataTransfer.setData("application/x-umbra-folder", record.id); event.dataTransfer.effectAllowed = "move"; } }} variant={folder === item ? "secondary" : "ghost"} title={item} aria-label={`Папка ${item}`} className={row(folder === item) + (dropTarget === item ? " ring-2 ring-primary" : "")} onClick={() => select(item)}>
          <Icon className={"size-4 shrink-0 " + (folder === item ? "text-primary" : "text-muted-foreground")} />{label(item, count(item))}
        </Button></ContextMenuTrigger><ContextMenuContent><ContextMenuItem onSelect={() => select(item)}>Открыть</ContextMenuItem>{can("folder.manage") && record && !record.isDefault && !record.virtual && <><ContextMenuItem onSelect={() => { const name = window.prompt("Новое название папки", item)?.trim(); if (name && name !== item && ws) void renameFn({ data: { teamId: ws.teamId, id: record.id, name } }).then(() => { if (folder === item) setFolder(name); void qc.invalidateQueries({ queryKey: ["folders"] }); void qc.invalidateQueries({ queryKey: ["profiles"] }); }).catch((error: Error) => toast.error(error.message)); }}>Переименовать</ContextMenuItem><ContextMenuItem onSelect={() => { if (ws && window.confirm(`Удалить папку «${item}»? Профили перейдут в основную.`)) void deleteFn({ data: { teamId: ws.teamId, id: record.id } }).then(() => { if (folder === item) setFolder(ALL_FOLDERS); void qc.invalidateQueries({ queryKey: ["folders"] }); void qc.invalidateQueries({ queryKey: ["profiles"] }); }).catch((error: Error) => toast.error(error.message)); }}>Удалить</ContextMenuItem></>}</ContextMenuContent></ContextMenu>;
      })}
    </div>
  </div>;
}
