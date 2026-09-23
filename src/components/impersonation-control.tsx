import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Eye, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { getUsableSession } from "@/lib/auth-session";
import { endEmployeeSession, listMembers, startEmployeeSession, type Workspace } from "@/lib/team.functions";

const STORAGE_KEY = "umbra:impersonation";
type Escrow = {
  ownerAccessToken: string; ownerRefreshToken: string; ownerId: string;
  employeeId: string; employeeEmail: string; teamId: string;
};

function readEscrow(): Escrow | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Escrow;
    return value.ownerAccessToken && value.ownerRefreshToken && value.employeeId ? value : null;
  } catch { return null; }
}

export function ImpersonationControl({ workspace, closeProfiles }: { workspace: Workspace | undefined; closeProfiles: () => Promise<void> }) {
  const [escrow, setEscrow] = useState<Escrow | null>(null);
  const [busy, setBusy] = useState(false);
  const listFn = useServerFn(listMembers);
  const startFn = useServerFn(startEmployeeSession);
  const endFn = useServerFn(endEmployeeSession);
  useEffect(() => { setEscrow(readEscrow()); }, []);
  const team = useQuery({ queryKey: ["impersonation-members", workspace?.teamId], queryFn: () => listFn({ data: { teamId: workspace!.teamId } }), enabled: !!workspace?.isSuperadmin && !escrow });

  async function enter(userId: string) {
    if (!workspace || busy) return;
    const employee = team.data?.members.find((row) => row.userId === userId);
    if (!employee || !window.confirm(`Войти как ${employee.email}? Открытые профили будут закрыты. Все вкладки Umbra в этом браузере переключатся на сотрудника.`)) return;
    setBusy(true);
    try {
      await closeProfiles();
      const owner = await getUsableSession();
      if (!owner || owner.user.id !== workspace.userId) throw new Error("Сессия владельца недоступна. Войдите заново.");
      const issued = await startFn({ data: { teamId: workspace.teamId, userId } });
      const saved: Escrow = { ownerAccessToken: owner.access_token, ownerRefreshToken: owner.refresh_token, ownerId: owner.user.id, employeeId: userId, employeeEmail: issued.email, teamId: workspace.teamId };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      const result = await supabase.auth.setSession({ access_token: issued.accessToken, refresh_token: issued.refreshToken });
      if (result.error || result.data.user?.id !== userId) {
        await supabase.auth.setSession({ access_token: owner.access_token, refresh_token: owner.refresh_token });
        sessionStorage.removeItem(STORAGE_KEY);
        throw new Error("Не удалось переключиться на сотрудника");
      }
      window.location.assign("/app");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось войти под сотрудником"); setBusy(false); }
  }

  async function leave() {
    if (!escrow || busy) return;
    setBusy(true);
    try {
      await closeProfiles();
      const result = await supabase.auth.setSession({ access_token: escrow.ownerAccessToken, refresh_token: escrow.ownerRefreshToken });
      if (result.error || result.data.user?.id !== escrow.ownerId) throw new Error("Не удалось вернуть сессию владельца. Войдите в свой аккаунт вручную.");
      sessionStorage.removeItem(STORAGE_KEY);
      try { await endFn({ data: { teamId: escrow.teamId, userId: escrow.employeeId } }); } catch { /* Возврат не блокируется журналом. */ }
      window.location.assign("/app");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Не удалось вернуться в свой аккаунт"); setBusy(false); }
  }

  if (escrow) return <div className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs"><p className="break-all">Вы как {escrow.employeeEmail}</p><p className="text-muted-foreground">Все действия выполняются с правами сотрудника.</p><Button variant="outline" size="sm" className="w-full" disabled={busy} onClick={() => void leave()}><RotateCcw className="size-4" />Вернуться к себе</Button></div>;
  if (!workspace?.isSuperadmin) return null;
  return <div className="space-y-1"><p className="text-xs text-muted-foreground">Войти как сотрудник</p><Select disabled={busy || team.isPending} onValueChange={(userId) => void enter(userId)}><SelectTrigger aria-label="Войти под учётной записью сотрудника" className="w-full text-xs"><Eye className="size-4" /><SelectValue placeholder="Выберите сотрудника" /></SelectTrigger><SelectContent>{(team.data?.members ?? []).filter((row) => row.role === "member").map((row) => <SelectItem key={row.userId} value={row.userId}>{row.email}</SelectItem>)}</SelectContent></Select></div>;
}
