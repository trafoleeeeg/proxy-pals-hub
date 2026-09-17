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
  const row = (active: boolean) => "h-8 w-full justify-center gap-3 px-2 text-xs md:justify-start " + (active ? "" : "text-muted-foreground");
  return <div className="mt-2 border-t border-sidebar-border pt-2">
    <p className="hidden px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground md:block">Папки</p>
    <div className="flex flex-col gap-0.5">
      <Button variant={folder === ALL_FOLDERS ? "secondary" : "ghost"} title="Все профили" aria-label="Все профили" className={row(folder === ALL_FOLDERS)} onClick={() => setFolder(ALL_FOLDERS)}>
        <FolderOpen className="size-4 shrink-0 text-primary" /><span className="hidden truncate md:inline">Все профили</span><span className="ml-auto hidden tabular-nums text-muted-foreground md:inline">{profiles.data?.length ?? 0}</span>
      </Button>
      <Button variant={folder === "" ? "secondary" : "ghost"} title="Без папки" aria-label="Без папки" className={row(folder === "")} onClick={() => setFolder("")}>
        <Archive className="size-4 shrink-0 text-warning" /><span className="hidden truncate md:inline">Без папки</span><span className="ml-auto hidden tabular-nums text-muted-foreground md:inline">{count("")}</span>
      </Button>
      {items.map((item, index) => {
        const Icon = icons[index % icons.length] ?? Folder;
        return <Button key={item} variant={folder === item ? "secondary" : "ghost"} title={item} aria-label={`Папка ${item}`} className={row(folder === item)} onClick={() => setFolder(item)}>
          <Icon className={"size-4 shrink-0 " + (folder === item ? "text-primary" : "text-muted-foreground")} /><span className="hidden truncate md:inline">{item}</span><span className="ml-auto hidden tabular-nums text-muted-foreground md:inline">{count(item)}</span>
        </Button>;
      })}
    </div>
  </div>;
}
