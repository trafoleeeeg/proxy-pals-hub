import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/lib/usePermissions";
import { listTrash, restoreProfile } from "@/lib/trash.functions";
import { useWorkspace } from "@/lib/useWorkspace";

export const Route = createFileRoute("/_authenticated/app/trash")({ component: TrashPage });

function timeLeft(deletedAt: string, now: number) {
  const expires = new Date(deletedAt).getTime() + 14 * 86_400_000;
  const remaining = Math.max(0, expires - now);
  return `${Math.floor(remaining / 86_400_000)} д. ${Math.floor((remaining % 86_400_000) / 3_600_000)} ч. ${Math.floor((remaining % 3_600_000) / 60_000)} мин.`;
}

export function TrashPage() {
  const { data: ws } = useWorkspace();
  const { can } = usePermissions(ws?.teamId);
  const qc = useQueryClient();
  const listFn = useServerFn(listTrash);
  const restoreFn = useServerFn(restoreProfile);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const trash = useQuery({ queryKey: ["trash", ws?.teamId], queryFn: () => listFn({ data: { teamId: ws!.teamId } }), enabled: !!ws });
  const restore = useMutation({ mutationFn: (profileId: string) => restoreFn({ data: { teamId: ws!.teamId, profileId } }), onSuccess: async () => { toast.success("Профиль восстановлен"); await Promise.all([qc.invalidateQueries({ queryKey: ["trash"] }), qc.invalidateQueries({ queryKey: ["profiles"] })]); }, onError: (error: Error) => toast.error(error.message) });
  return <div className="space-y-5"><div><h1 className="text-2xl font-semibold">Корзина</h1><p className="mt-1 text-sm text-muted-foreground">Удалённые профили хранятся 14 дней. Восстановление возвращает профиль вместе с cookies и настройками.</p></div>
    {trash.isPending && <p role="status">Загрузка корзины…</p>}
    {trash.isError && <p role="alert" className="text-destructive">Не удалось загрузить корзину. <Button variant="outline" onClick={() => trash.refetch()}>Повторить</Button></p>}
    {trash.data && <div className="divide-y rounded-lg border border-border bg-card">{trash.data.map((row) => <div key={row.id} className="flex flex-wrap items-center gap-3 p-3"><div className="min-w-0 flex-1"><p className="truncate font-medium">{row.name}</p><p className="text-xs text-muted-foreground">{row.folder || "Основная"} · удалён {new Date(row.deleted_at).toLocaleString("ru-RU")}</p></div><p className="text-xs text-warning">До удаления: {timeLeft(row.deleted_at, now)}</p>{can("profile.delete") && <Button variant="outline" size="sm" disabled={restore.isPending} onClick={() => restore.mutate(row.id)}><RotateCcw className="size-4" />Восстановить</Button>}</div>)}{!trash.data.length && <p className="p-8 text-center text-sm text-muted-foreground">Корзина пуста</p>}</div>}
  </div>;
}
