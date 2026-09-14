import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/lib/useWorkspace";
import {
  listMembers,
  createInvite,
  revokeInvite,
  removeMember,
  listAudit,
  setProfileAccess,
} from "@/lib/team.functions";
import { listProfiles } from "@/lib/profiles.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/app/team")({
  component: TeamPage,
});

function TeamPage() {
  const { data: ws } = useWorkspace();
  const qc = useQueryClient();
  const members = useServerFn(listMembers);
  const invite = useServerFn(createInvite);
  const revoke = useServerFn(revokeInvite);
  const kick = useServerFn(removeMember);
  const audit = useServerFn(listAudit);
  const profilesFn = useServerFn(listProfiles);
  const accessFn = useServerFn(setProfileAccess);
  const [email, setEmail] = useState("");

  const isOwner = ws?.role === "owner";

  const team = useQuery({
    queryKey: ["team", ws?.teamId],
    queryFn: () => members({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && isOwner,
  });

  const profiles = useQuery({
    queryKey: ["profiles", ws?.teamId],
    queryFn: () => profilesFn({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && isOwner,
  });

  const log = useQuery({
    queryKey: ["audit", ws?.teamId],
    queryFn: () => audit({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId && isOwner,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["team"] });

  const inviteMut = useMutation({
    mutationFn: () => invite({ data: { teamId: ws!.teamId, email } }),
    onSuccess: (row) => {
      const link = `${window.location.origin}/invite/${row.token}`;
      navigator.clipboard?.writeText(link);
      toast.success("Ссылка приглашения скопирована");
      setEmail("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const accessMut = useMutation({
    mutationFn: (v: { profileId: string; userId: string; granted: boolean }) =>
      accessFn({ data: v }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });

  if (!isOwner) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-sm text-muted-foreground">
        Управление командой доступно только владельцу.
      </div>
    );
  }

  const accessSet = new Set(
    (team.data?.access ?? []).map((a) => `${a.profile_id}:${a.user_id}`),
  );
  const staff = (team.data?.members ?? []).filter((m) => m.role === "member");

  return (
    <div>
      <h1 className="text-2xl font-semibold">Команда</h1>
      <p className="text-sm text-muted-foreground">
        Приглашайте сотрудников и открывайте им только нужные профили.
      </p>

      <Tabs defaultValue="members" className="mt-6">
        <TabsList>
          <TabsTrigger value="members">Участники</TabsTrigger>
          <TabsTrigger value="access">Доступы</TabsTrigger>
          <TabsTrigger value="log">Журнал</TabsTrigger>
        </TabsList>

        <TabsContent value="members" className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="почта сотрудника"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="max-w-xs"
            />
            <Button onClick={() => inviteMut.mutate()} disabled={!email || inviteMut.isPending}>
              Пригласить
            </Button>
          </div>

          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Почта</TableHead>
                  <TableHead>Роль</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(team.data?.members ?? []).map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{m.email}</TableCell>
                    <TableCell>
                      <Badge variant={m.role === "owner" ? "default" : "outline"}>
                        {m.role === "owner" ? "владелец" : "сотрудник"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {m.role === "member" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            kick({ data: { teamId: ws!.teamId, userId: m.userId } })
                              .then(refresh)
                              .catch((e: Error) => toast.error(e.message))
                          }
                        >
                          Убрать
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {(team.data?.invites ?? []).length > 0 && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Ожидают принятия</h2>
              <ul className="space-y-2">
                {(team.data?.invites ?? []).map((i) => (
                  <li key={i.id} className="flex items-center gap-3 text-sm">
                    <span>{i.email}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard?.writeText(
                          `${window.location.origin}/invite/${i.token}`,
                        );
                        toast.success("Ссылка скопирована");
                      }}
                    >
                      Скопировать ссылку
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        revoke({ data: { inviteId: i.id } })
                          .then(refresh)
                          .catch((e: Error) => toast.error(e.message))
                      }
                    >
                      Отозвать
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </TabsContent>

        <TabsContent value="access">
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Профиль</TableHead>
                  {staff.map((m) => (
                    <TableHead key={m.userId} className="text-center text-xs">
                      {m.email}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(profiles.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    {staff.map((m) => {
                      const granted = accessSet.has(`${p.id}:${m.userId}`);
                      return (
                        <TableCell key={m.userId} className="text-center">
                          <Checkbox
                            checked={granted}
                            onCheckedChange={(v) =>
                              accessMut.mutate({
                                profileId: p.id,
                                userId: m.userId,
                                granted: Boolean(v),
                              })
                            }
                          />
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
                {staff.length === 0 && (
                  <TableRow>
                    <TableCell className="py-8 text-sm text-muted-foreground">
                      Сначала пригласите сотрудников
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="log">
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Когда</TableHead>
                  <TableHead>Кто</TableHead>
                  <TableHead>Действие</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(log.data ?? []).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="mono text-xs">
                      {new Date(r.created_at).toLocaleString("ru-RU")}
                    </TableCell>
                    <TableCell className="text-xs">{r.email ?? "—"}</TableCell>
                    <TableCell className="mono text-xs">{r.action}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
