import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listAudit } from "@/lib/team.functions";
import { useWorkspace } from "@/lib/useWorkspace";

export const Route = createFileRoute("/_authenticated/app/audit")({ component: AuditPage });

function remaining(createdAt: string, now: number) {
  const expires = new Date(createdAt);
  expires.setMonth(expires.getMonth() + 2);
  const ms = Math.max(0, expires.getTime() - now);
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return `${days} д. ${hours} ч.`;
}

export function AuditPage() {
  const { data: ws } = useWorkspace();
  const audit = useServerFn(listAudit);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const valid = !from || !to || from <= to;
  const records = useQuery({
    queryKey: ["audit", ws?.teamId, from, to],
    queryFn: () => audit({ data: { teamId: ws!.teamId, ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}), ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}) } }),
    enabled: !!ws?.canManage && valid,
  });
  if (!ws) return <p role="status">Загрузка журнала…</p>;
  if (!ws.canManage) return <p role="alert">Журнал доступен владельцу и администраторам.</p>;
  return <div className="space-y-5">
    <div><h1 className="text-2xl font-semibold">Журнал команды</h1><p className="mt-1 text-sm text-muted-foreground">Записи удаляются через два месяца. Время до очистки показано для каждой записи.</p></div>
    <div className="flex flex-wrap items-end gap-3"><label className="space-y-1 text-sm">С даты<Input aria-label="Начало периода" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label className="space-y-1 text-sm">По дату<Input aria-label="Конец периода" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><Button variant="outline" onClick={() => { setFrom(""); setTo(""); }}>Сбросить</Button></div>
    {!valid && <p role="alert" className="text-sm text-destructive">Начало периода позже конца.</p>}
    {records.isPending && valid && <p role="status">Загрузка записей…</p>}
    {records.isError && <p role="alert" className="text-sm text-destructive">Не удалось загрузить журнал. <Button variant="outline" onClick={() => records.refetch()}>Повторить</Button></p>}
    {records.data && <div className="overflow-x-auto rounded-lg border border-border bg-card"><Table><TableHeader><TableRow><TableHead>Когда</TableHead><TableHead>Кто</TableHead><TableHead>Действие</TableHead><TableHead>До очистки</TableHead></TableRow></TableHeader><TableBody>{records.data.map((row) => <TableRow key={row.id}><TableCell className="whitespace-nowrap text-xs">{new Date(row.created_at).toLocaleString("ru-RU")}</TableCell><TableCell className="text-xs">{row.email || "—"}</TableCell><TableCell className="text-xs">{row.action}</TableCell><TableCell className="whitespace-nowrap text-xs">{remaining(row.created_at, now)}</TableCell></TableRow>)}{!records.data.length && <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">За выбранный период записей нет</TableCell></TableRow>}</TableBody></Table></div>}
    {records.data && records.data.length >= 500 && <p className="text-xs text-warning">Показаны последние 500 записей периода. Уточните даты для просмотра остальных.</p>}
  </div>;
}
