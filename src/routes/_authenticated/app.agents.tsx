import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/lib/useWorkspace";
import {
  createAgentKey,
  deleteAgentKey,
  listAgentActivity,
  listAgentKeys,
  revokeAgentKey,
} from "@/lib/agent-keys.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

export const Route = createFileRoute("/_authenticated/app/agents")({
  head: () => ({
    meta: [
      { title: "Агенты — Umbra" },
      { name: "description", content: "Ключи доступа для Claude, Codex и других агентов." },
      { property: "og:title", content: "Агенты — Umbra" },
      {
        property: "og:description",
        content: "Ключи доступа для Claude, Codex и других агентов.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AgentsPage,
});

const SCOPES: { id: string; label: string; hint: string }[] = [
  { id: "profiles:read", label: "Читать профили", hint: "видит список профилей и папки" },
  { id: "profiles:write", label: "Менять профили", hint: "создаёт, правит и удаляет профили" },
  { id: "proxies:read", label: "Читать прокси", hint: "видит список прокси без паролей" },
  { id: "proxies:write", label: "Добавлять прокси", hint: "добавляет новые прокси" },
  { id: "team:read", label: "Видеть команду", hint: "читает состав команды" },
];

function AgentsPage() {
  const { data: ws } = useWorkspace();
  const qc = useQueryClient();
  const teamId = ws?.teamId ?? "";
  const isOwner = ws?.role === "owner";

  const list = useServerFn(listAgentKeys);
  const activity = useServerFn(listAgentActivity);
  const create = useServerFn(createAgentKey);
  const revoke = useServerFn(revokeAgentKey);
  const remove = useServerFn(deleteAgentKey);

  const keys = useQuery({
    queryKey: ["agent-keys", teamId],
    queryFn: () => list({ data: { teamId } }),
    enabled: Boolean(teamId) && isOwner,
  });

  const log = useQuery({
    queryKey: ["agent-activity", teamId],
    queryFn: () => activity({ data: { teamId } }),
    enabled: Boolean(teamId) && isOwner,
  });

  const [name, setName] = useState("Claude");
  const [days, setDays] = useState("90");
  const [scopes, setScopes] = useState<string[]>(["profiles:read", "proxies:read"]);
  const [fresh, setFresh] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: () =>
      create({
        data: { teamId, name, scopes, days: days.trim() ? Number(days) : null },
      }),
    onSuccess: (r) => {
      setFresh(r.key);
      void qc.invalidateQueries({ queryKey: ["agent-keys", teamId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => revoke({ data: { teamId, id } }),
    onSuccess: () => {
      toast.success("Ключ отозван");
      void qc.invalidateQueries({ queryKey: ["agent-keys", teamId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => remove({ data: { teamId, id } }),
    onSuccess: () => {
      toast.success("Ключ удалён");
      void qc.invalidateQueries({ queryKey: ["agent-keys", teamId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!isOwner) {
    return <p className="text-sm text-muted-foreground">Раздел доступен только владельцу команды.</p>;
  }

  function toggle(id: string) {
    setScopes((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Агенты</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ключи доступа для Claude, Codex и других помощников. Ключ показывается один раз — сохраните
          его сразу.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-medium">Новый ключ</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="agent-name">Имя агента</Label>
            <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="agent-days">Срок действия, дней</Label>
            <Input
              id="agent-days"
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))}
              placeholder="пусто — без срока"
            />
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <Label>Права</Label>
          {SCOPES.map((s) => (
            <label key={s.id} className="flex items-start gap-3 text-sm">
              <Checkbox
                checked={scopes.includes(s.id)}
                onCheckedChange={() => toggle(s.id)}
                className="mt-0.5"
              />
              <span>
                {s.label}
                <span className="block text-xs text-muted-foreground">{s.hint}</span>
              </span>
            </label>
          ))}
        </div>

        <Button
          className="mt-5"
          disabled={createMut.isPending || !teamId}
          onClick={() => createMut.mutate()}
        >
          {createMut.isPending ? "Создаю…" : "Создать ключ"}
        </Button>

        {fresh && (
          <div className="mt-5 rounded-md border border-primary/40 bg-primary/10 p-4">
            <p className="text-sm font-medium">Ключ создан — скопируйте его сейчас</p>
            <p className="mono mt-2 break-all rounded bg-background px-3 py-2 text-xs">{fresh}</p>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(fresh);
                    toast.success("Скопировано");
                  } catch {
                    toast.error("Не удалось скопировать ключ. Разрешите доступ к буферу обмена.");
                  }
                }}
              >
                Скопировать
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFresh(null)}>
                Скрыть
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card">
        <h2 className="border-b border-border px-5 py-3 text-sm font-medium">Выданные ключи</h2>
        {keys.isPending ? (
          <p role="status" className="px-5 py-6 text-sm text-muted-foreground">Загрузка ключей…</p>
        ) : keys.isError ? (
          <p role="alert" className="px-5 py-6 text-sm text-destructive">Не удалось загрузить ключи. <Button size="sm" variant="outline" onClick={() => keys.refetch()}>Повторить</Button></p>
        ) : (keys.data ?? []).length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">Пока ни одного ключа.</p>
        ) : (
          <ul className="divide-y divide-border">
            {(keys.data ?? []).map((k) => {
              const expired = k.expires_at && new Date(k.expires_at) < new Date();
              const dead = Boolean(k.revoked_at) || Boolean(expired);
              return (
                <li key={k.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                  <div className="min-w-40">
                    <p className="font-medium">{k.name}</p>
                    <p className="mono text-xs text-muted-foreground">{k.key_prefix}…</p>
                  </div>
                  <p className="text-xs text-muted-foreground">{k.scopes.join(", ")}</p>
                  <p className="text-xs text-muted-foreground">
                    {k.last_used_at
                      ? `был ${new Date(k.last_used_at).toLocaleString("ru")}`
                      : "не использовался"}
                  </p>
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      dead ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary"
                    }`}
                  >
                    {k.revoked_at ? "отозван" : expired ? "истёк" : "активен"}
                  </span>
                  <div className="ml-auto flex gap-2">
                    {!dead && (
                      <Button size="sm" variant="secondary" onClick={() => revokeMut.mutate(k.id)}>
                        Отозвать
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => removeMut.mutate(k.id)}>
                      Удалить
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card">
        <h2 className="border-b border-border px-5 py-3 text-sm font-medium">Действия агентов</h2>
        {log.isPending ? (
          <p role="status" className="px-5 py-6 text-sm text-muted-foreground">Загрузка действий…</p>
        ) : log.isError ? (
          <p role="alert" className="px-5 py-6 text-sm text-destructive">Не удалось загрузить действия. <Button size="sm" variant="outline" onClick={() => log.refetch()}>Повторить</Button></p>
        ) : (log.data ?? []).length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">Агенты пока ничего не делали.</p>
        ) : (
          <ul className="divide-y divide-border">
            {(log.data ?? []).map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-5 py-2 text-sm">
                <span className="mono text-xs text-muted-foreground">
                  {new Date(r.created_at).toLocaleString("ru")}
                </span>
                <span>{r.action}</span>
                <span className="text-xs text-muted-foreground">
                  {(r.meta as { agent?: string } | null)?.agent ?? ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
