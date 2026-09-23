import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { GripVertical, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useWorkspace } from "@/lib/useWorkspace";
import { usePermissions } from "@/lib/usePermissions";
import { createFolder, deleteFolder, listFolderAccess, listFolders, renameFolder, reorderFolders, setFolderAccess, type FolderRow } from "@/lib/folders.functions";
import { listMembers } from "@/lib/team.functions";

export const Route = createFileRoute("/_authenticated/app/folders")({ component: FoldersPage });

export function FoldersPage() {
  const { data: ws } = useWorkspace();
  const { can } = usePermissions(ws?.teamId);
  const qc = useQueryClient();
  const listFn = useServerFn(listFolders);
  const membersFn = useServerFn(listMembers);
  const accessFn = useServerFn(listFolderAccess);
  const createFn = useServerFn(createFolder);
  const renameFn = useServerFn(renameFolder);
  const deleteFn = useServerFn(deleteFolder);
  const reorderFn = useServerFn(reorderFolders);
  const setAccessFn = useServerFn(setFolderAccess);
  const [name, setName] = useState("");
  const [dragged, setDragged] = useState<string | null>(null);
  const [order, setOrder] = useState<FolderRow[] | null>(null);
  const folders = useQuery({ queryKey: ["folders", ws?.teamId], queryFn: () => listFn({ data: { teamId: ws!.teamId } }), enabled: !!ws });
  const members = useQuery({ queryKey: ["team", ws?.teamId], queryFn: () => membersFn({ data: { teamId: ws!.teamId } }), enabled: !!ws?.canManage });
  const access = useQuery({ queryKey: ["folder-access", ws?.teamId], queryFn: () => accessFn({ data: { teamId: ws!.teamId } }), enabled: !!ws?.canManage });
  const refresh = async () => { setOrder(null); await Promise.all([qc.invalidateQueries({ queryKey: ["folders"] }), qc.invalidateQueries({ queryKey: ["profiles"] }), qc.invalidateQueries({ queryKey: ["folder-access"] })]); };
  const mutate = useMutation({ mutationFn: async (action: () => Promise<unknown>) => action(), onSuccess: refresh, onError: (error: Error) => toast.error(error.message) });
  const rows = order ?? folders.data ?? [];
  const movable = rows.filter((row) => !row.isDefault && !row.virtual);
  const people = (members.data?.members ?? []).filter((row) => row.role === "member");
  const granted = new Set((access.data ?? []).map((row) => `${row.folder}:${row.userId}`));

  function move(target: string) {
    if (!ws || !dragged || dragged === target || mutate.isPending) return;
    const source = movable.findIndex((row) => row.id === dragged);
    const destination = movable.findIndex((row) => row.id === target);
    if (source < 0 || destination < 0) return;
    const next = [...movable];
    const [moved] = next.splice(source, 1);
    if (!moved) return;
    next.splice(destination, 0, moved);
    setOrder([...rows.filter((row) => row.isDefault), ...next, ...rows.filter((row) => row.virtual)]);
    mutate.mutate(() => reorderFn({ data: { teamId: ws.teamId, ids: next.map((row) => row.id) } }));
  }

  if (!ws) return <p role="status">Загрузка папок…</p>;
  return <div className="max-w-5xl space-y-5">
    <div><h1 className="text-2xl font-semibold">Папки</h1><p className="mt-1 text-sm text-muted-foreground">Папки всегда видны слева. Перетащите строку за значок, чтобы изменить порядок.</p></div>
    {can("folder.manage") && <div className="flex flex-wrap gap-2"><Input className="max-w-xs" aria-label="Название новой папки" placeholder="Название новой папки" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) { mutate.mutate(() => createFn({ data: { teamId: ws.teamId, name: name.trim() } })); setName(""); } }} /><Button disabled={!name.trim() || mutate.isPending} onClick={() => { mutate.mutate(() => createFn({ data: { teamId: ws.teamId, name: name.trim() } })); setName(""); }}>Создать</Button></div>}
    {folders.isError && <p role="alert" className="text-destructive">Не удалось загрузить папки. <Button variant="outline" onClick={() => folders.refetch()}>Повторить</Button></p>}
    <div className="divide-y rounded-lg border border-border bg-card">
      {rows.map((row) => <div key={row.id} className="flex items-center gap-2 p-3" draggable={can("folder.manage") && !row.isDefault && !row.virtual} onDragStart={(event) => { setDragged(row.id); event.dataTransfer.effectAllowed = "move"; }} onDragOver={(event) => { if (dragged && !row.isDefault && !row.virtual) event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); move(row.id); }} onDragEnd={() => setDragged(null)}>
        {can("folder.manage") && !row.isDefault && !row.virtual ? <GripVertical className="size-4 cursor-grab text-muted-foreground" aria-label="Перетащить папку" /> : <span className="w-4" />}
        <span className="min-w-0 flex-1 truncate text-sm">{row.name}{row.isDefault && <span className="ml-2 text-xs text-muted-foreground">основная</span>}{row.virtual && <span className="ml-2 text-xs text-muted-foreground">из профилей</span>}</span>
        {can("folder.manage") && !row.isDefault && !row.virtual && <><Button variant="ghost" size="sm" disabled={mutate.isPending} onClick={() => { const next = window.prompt("Новое название папки", row.name)?.trim(); if (next && next !== row.name) mutate.mutate(() => renameFn({ data: { teamId: ws.teamId, id: row.id, name: next } })); }}><Pencil className="size-4" />Переименовать</Button><Button variant="ghost" size="sm" disabled={mutate.isPending} onClick={() => { if (window.confirm(`Удалить папку «${row.name}»? Профили перейдут в основную.`)) mutate.mutate(() => deleteFn({ data: { teamId: ws.teamId, id: row.id } })); }}><Trash2 className="size-4" />Удалить</Button></>}
      </div>)}
    </div>
    {ws.canManage && <section className="space-y-2"><h2 className="text-lg font-semibold">Доступ сотрудников к папкам</h2><p className="text-sm text-muted-foreground">Разрешение на папку открывает сотруднику все профили внутри, в том числе новые.</p><div className="overflow-x-auto rounded-lg border border-border bg-card"><table className="w-full text-sm"><thead><tr className="border-b"><th className="p-3 text-left">Папка</th>{people.map((person) => <th key={person.userId} className="p-3 text-center">{person.email}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-b last:border-0"><td className="p-3">{row.name}</td>{people.map((person) => <td key={person.userId} className="p-3 text-center"><Checkbox aria-label={`Доступ ${person.email} к папке ${row.name}`} checked={granted.has(`${row.name}:${person.userId}`)} disabled={mutate.isPending} onCheckedChange={(value) => mutate.mutate(() => setAccessFn({ data: { teamId: ws.teamId, folder: row.name, userId: person.userId, granted: value === true } }))} /></td>)}</tr>)}</tbody></table></div></section>}
  </div>;
}
