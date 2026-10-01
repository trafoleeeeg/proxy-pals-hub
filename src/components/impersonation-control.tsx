import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Eye, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { beginEmployeePreview, employeePreview, leaveEmployeePreview } from "@/lib/app-supabase";
import { queueEmployeeExit, takeEmployeeExit, type EmployeePreview } from "@/lib/employee-session-storage";
import { getUsableSession } from "@/lib/auth-session";
import { endEmployeeSession, listMembers, startEmployeeSession, type Workspace } from "@/lib/team.functions";

export function ImpersonationControl({ workspace, closeProfiles }: { workspace: Workspace | undefined; closeProfiles: () => Promise<void> }) {
  const [escrow, setEscrow] = useState<EmployeePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const listFn = useServerFn(listMembers);
  const startFn = useServerFn(startEmployeeSession);
  const endFn = useServerFn(endEmployeeSession);
  useEffect(() => { setEscrow(employeePreview()); }, []);
  useEffect(() => {
    if (!workspace?.isSuperadmin) return;
    const ended = takeEmployeeExit(sessionStorage, workspace.userId);
    // The audit request runs after reload under the restored primary account,
    // never with employee credentials or a caller-supplied owner token.
    if (ended) void endFn({ data: { teamId: ended.teamId, userId: ended.employeeId } }).catch(() => {});
  }, [workspace?.isSuperadmin, workspace?.userId, endFn]);
  const team = useQuery({ queryKey: ["impersonation-members", workspace?.teamId], queryFn: () => listFn({ data: { teamId: workspace!.teamId } }), enabled: !!workspace?.isSuperadmin && !escrow });

  async function enter(userId: string) {
    if (!workspace || busy) return;
    const employee = team.data?.members.find((row) => row.userId === userId);
    if (!employee) return;
    setBusy(true);
    try {
      await closeProfiles();
      const owner = await getUsableSession();
      if (!owner || owner.user.id !== workspace.userId) throw new Error("Сессия владельца недоступна. Войдите заново.");
      const issued = await startFn({ data: { teamId: workspace.teamId, userId } });
      await beginEmployeePreview({ ownerId: owner.user.id, employeeId: userId, employeeEmail: issued.email, teamId: workspace.teamId },
        { access_token: issued.accessToken, refresh_token: issued.refreshToken });
      window.location.assign("/app");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось войти под сотрудником"); setBusy(false); }
  }

  async function leave() {
    if (!escrow || busy) return;
    setBusy(true);
    try {
      await closeProfiles();
      queueEmployeeExit(sessionStorage, escrow);
      await leaveEmployeePreview();
      window.location.assign("/app");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось вернуться в свой аккаунт"); setBusy(false); }
  }

  if (escrow && workspace?.userId === escrow.employeeId) return <div className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs"><p className="break-all">Вы как {escrow.employeeEmail}</p><p className="text-muted-foreground">Все действия выполняются с правами сотрудника. После перезапуска откроется ваш аккаунт.</p><Button variant="outline" size="sm" className="w-full" disabled={busy} onClick={() => void leave()}><RotateCcw className="size-4" />Вернуться к себе</Button></div>;
  if (!workspace?.isSuperadmin) return null;
  return <div className="space-y-1"><p className="text-xs text-muted-foreground">Войти как сотрудник</p><Select disabled={busy || team.isPending} onValueChange={(userId) => void enter(userId)}><SelectTrigger aria-label="Войти под учётной записью сотрудника" className="w-full text-xs"><Eye className="size-4" /><SelectValue placeholder="Выберите сотрудника" /></SelectTrigger><SelectContent>{(team.data?.members ?? []).filter((row) => row.role === "member").map((row) => <SelectItem key={row.userId} value={row.userId}>{row.email}</SelectItem>)}</SelectContent></Select></div>;
}
