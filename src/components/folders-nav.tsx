import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive, BriefcaseBusiness, Folder, FolderOpen, Globe2, ShoppingBag, UsersRound } from "lucide-react";
import { useMemo } from "react";
import { listProfiles } from "@/lib/profiles.functions";
import { useWorkspace } from "@/lib/useWorkspace";
import { ALL_FOLDERS, useProfileFolder } from "@/lib/useProfileFolder";
import { Button } from "@/components/ui/button";

const icons = [Folder, BriefcaseBusiness, ShoppingBag, UsersRound, Globe2];

export function FoldersNav({ collapsed = false }: { collapsed?: boolean }) {
  const { data: ws } = useWorkspace();
  const listFn = useServerFn(listProfiles);
  const { folder, setFolder } = useProfileFolder();
  const profiles = useQuery({
    queryKey: ["profiles", ws?.teamId],
    queryFn: () => { if (!ws) throw new Error("Команда не загружена"); return listFn({ data: { teamId: ws.teamId } }); },
    enabled: !!ws,
  });
  const items = useMemo(() => [...new Set((profiles.data ?? []).map((p) => p.folder).filter(Boolean))].sort(), [profiles.data]);
  const count = (name: string) => (profiles.data ?? []).filter((profile) => profile.folder === name).length;
  const row = (active: boolean) => "h-8 w-full gap-3 px-2 text-xs " + (collapsed ? "justify-center " : "justify-start ") + (active ? "" : "text-muted-foreground");
  const label = (text: string, value: number) => collapsed ? null : <><span className="truncate">{text}</span><span className="ml-auto tabular-nums text-muted-foreground">{value}</span></>;
  return <div className="mt-2 border-t border-sidebar-border pt-2">
    {!collapsed && <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Папки</p>}
    <div className="flex flex-col gap-0.5">
      <Button variant={folder === ALL_FOLDERS ? "secondary" : "ghost"} title="Все профили" aria-label="Все профили" className={row(folder === ALL_FOLDERS)} onClick={() => setFolder(ALL_FOLDERS)}>
        <FolderOpen className="size-4 shrink-0 text-primary" />{label("Все профили", profiles.data?.length ?? 0)}
      </Button>
      <Button variant={folder === "" ? "secondary" : "ghost"} title="Без папки" aria-label="Без папки" className={row(folder === "")} onClick={() => setFolder("")}>
        <Archive className="size-4 shrink-0 text-warning" />{label("Без папки", count(""))}
      </Button>
      {items.map((item, index) => {
        const Icon = icons[index % icons.length] ?? Folder;
        return <Button key={item} variant={folder === item ? "secondary" : "ghost"} title={item} aria-label={`Папка ${item}`} className={row(folder === item)} onClick={() => setFolder(item)}>
          <Icon className={"size-4 shrink-0 " + (folder === item ? "text-primary" : "text-muted-foreground")} />{label(item, count(item))}
        </Button>;
      })}
    </div>
  </div>;
}
