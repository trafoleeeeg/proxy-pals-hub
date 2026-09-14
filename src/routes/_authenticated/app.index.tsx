import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/lib/useWorkspace";
import {
  listProfiles,
  saveProfile,
  deleteProfile,
  cloneProfile,
  bulkCreateProfiles,
} from "@/lib/profiles.functions";
import {
  launchProfile,
  closeProfile as closeProfileSession,
  heartbeatProfile,
} from "@/lib/session.functions";
import { listProxies } from "@/lib/proxies.functions";
import { desktop } from "@/lib/desktop";
import { generateFingerprint, describeFingerprint, type Fingerprint } from "@/lib/fingerprint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/app/")({
  component: ProfilesPage,
});

const NO_PROXY = "none";
const ALL_FOLDERS = "__all__";

function ProfilesPage() {
  const { data: ws } = useWorkspace();
  const qc = useQueryClient();
  const listFn = useServerFn(listProfiles);
  const saveFn = useServerFn(saveProfile);
  const delFn = useServerFn(deleteProfile);
  const cloneFn = useServerFn(cloneProfile);
  const bulkFn = useServerFn(bulkCreateProfiles);
  const proxiesFn = useServerFn(listProxies);
  const launchFn = useServerFn(launchProfile);
  const closeFn = useServerFn(closeProfileSession);
  const beatFn = useServerFn(heartbeatProfile);

  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState<string>(ALL_FOLDERS);
  const [open, setOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [running, setRunning] = useState<string[]>([]);
  const [bulkForm, setBulkForm] = useState({ prefix: "Профиль", count: "10", folder: "" });
  const [editing, setEditing] = useState<{
    id?: string;
    name: string;
    folder: string;
    tags: string;
    notes: string;
    proxyId: string;
    fingerprint: Fingerprint;
  } | null>(null);

  const runningRef = useRef<string[]>([]);
  runningRef.current = running;

  const profiles = useQuery({
    queryKey: ["profiles", ws?.teamId],
    queryFn: () => listFn({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId,
    refetchInterval: 20_000,
  });

  const proxies = useQuery({
    queryKey: ["proxies", ws?.teamId],
    queryFn: () => proxiesFn({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["profiles"] });

  // Профиль закрыт в приложении — сохраняем сессии сайтов и снимаем блокировку.
  useEffect(() => {
    const b = desktop();
    if (!b) return;
    return b.onProfileClosed(async ({ profileId, cookies }) => {
      try {
        await closeFn({ data: { profileId, ...(cookies ? { cookies } : {}) } });
        toast.success("Сессии профиля сохранены");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Не удалось сохранить сессии профиля");
      }
      setRunning((r) => r.filter((id) => id !== profileId));
      invalidate();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Пока профиль открыт — держим блокировку и периодически сохраняем сессии.
  useEffect(() => {
    const b = desktop();
    if (!b) return;
    const timer = setInterval(async () => {
      for (const profileId of runningRef.current) {
        await beatFn({ data: { profileId } }).catch(() => {});
        const snap = await b.profileCookies(profileId).catch(() => null);
        if (snap?.cookies) {
          await closeFn({ data: { profileId, cookies: snap.cookies } }).catch(() => {});
          await launchFn({ data: { profileId, device: b.platform } }).catch(() => {});
        }
      }
    }, 120_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveMut = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          id: editing?.id,
          teamId: ws!.teamId,
          name: editing!.name,
          folder: editing!.folder,
          tags: editing!.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          notes: editing!.notes,
          proxyId: editing!.proxyId === NO_PROXY ? null : editing!.proxyId,
          fingerprint: editing!.fingerprint,
        },
      }),
    onSuccess: () => {
      toast.success("Профиль сохранён");
      setOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const bulkMut = useMutation({
    mutationFn: () => {
      const count = Math.min(Number(bulkForm.count) || 0, 200);
      return bulkFn({
        data: {
          teamId: ws!.teamId,
          prefix: bulkForm.prefix,
          count,
          folder: bulkForm.folder,
          fingerprints: Array.from({ length: count }, () => generateFingerprint()),
        },
      });
    },
    onSuccess: (r) => {
      toast.success(`Создано профилей: ${r.added}`);
      setBulkOpen(false);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function start(profileId: string) {
    const b = desktop();
    if (!b) {
      toast.error("Запуск профиля доступен в приложении Umbra для Windows");
      return;
    }
    try {
      const data = await launchFn({ data: { profileId, device: b.platform } });
      const r = await b.launchProfile({
        profileId: data.profileId,
        name: data.name,
        fingerprint: data.fingerprint,
        proxy: data.proxy,
        cookies: data.cookies,
      });
      if (!r.ok) throw new Error(r.error || "Не удалось открыть профиль");
      setRunning((list) => [...new Set([...list, profileId])]);
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось запустить профиль");
    }
  }

  async function stop(profileId: string) {
    const b = desktop();
    if (!b) return;
    await b.closeProfile(profileId);
  }

  const proxyLabel = useMemo(() => {
    const map = new Map((proxies.data ?? []).map((p) => [p.id, `${p.label} (${p.host})`]));
    return (id: string | null) => (id ? (map.get(id) ?? "—") : "—");
  }, [proxies.data]);

  const folders = useMemo(() => {
    const set = new Set((profiles.data ?? []).map((p) => p.folder).filter(Boolean));
    return [...set].sort();
  }, [profiles.data]);

  const rows = (profiles.data ?? [])
    .filter((p) => folder === ALL_FOLDERS || p.folder === folder)
    .filter((p) =>
      (p.name + p.folder + p.tags.join(" ")).toLowerCase().includes(search.toLowerCase()),
    );

  function openNew() {
    const proxy = proxies.data?.[0];
    setEditing({
      name: `Профиль ${(profiles.data?.length ?? 0) + 1}`,
      folder: folder === ALL_FOLDERS ? "" : folder,
      tags: "",
      notes: "",
      proxyId: NO_PROXY,
      fingerprint: generateFingerprint(proxy?.country ?? undefined),
    });
    setOpen(true);
  }

  return (
    <div className="flex gap-6">
      <div className="hidden w-48 shrink-0 lg:block">
        <p className="mono px-2 text-[11px] uppercase tracking-wide text-muted-foreground">Папки</p>
        <div className="mt-2 space-y-0.5">
          {[{ id: ALL_FOLDERS, label: "Все профили" }, ...folders.map((f) => ({ id: f, label: f }))].map(
            (f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFolder(f.id)}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  folder === f.id
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span className="truncate">{f.label}</span>
                <span className="mono text-[11px]">
                  {f.id === ALL_FOLDERS
                    ? (profiles.data ?? []).length
                    : (profiles.data ?? []).filter((p) => p.folder === f.id).length}
                </span>
              </button>
            ),
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Профили</h1>
            <p className="text-sm text-muted-foreground">
              Сессии сайтов сохраняются в профиль — команда продолжает работу с того же места.
            </p>
          </div>
          <div className="ml-auto flex gap-2">
            <Input
              placeholder="Поиск"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-48"
            />
            <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">Создать пачкой</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Создать несколько профилей</DialogTitle>
                </DialogHeader>
                <div className="grid gap-4">
                  <div className="space-y-2">
                    <Label>Название-основа</Label>
                    <Input
                      value={bulkForm.prefix}
                      onChange={(e) => setBulkForm({ ...bulkForm, prefix: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Сколько (до 200)</Label>
                    <Input
                      inputMode="numeric"
                      value={bulkForm.count}
                      onChange={(e) => setBulkForm({ ...bulkForm, count: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Папка</Label>
                    <Input
                      value={bulkForm.folder}
                      onChange={(e) => setBulkForm({ ...bulkForm, folder: e.target.value })}
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button onClick={() => bulkMut.mutate()} disabled={bulkMut.isPending}>
                    Создать
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Button onClick={openNew}>Новый профиль</Button>
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10" />
                <TableHead>Название</TableHead>
                <TableHead>Папка</TableHead>
                <TableHead>Прокси</TableHead>
                <TableHead>Отпечаток</TableHead>
                <TableHead>Состояние</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => {
                const isRunning = running.includes(p.id);
                return (
                  <TableRow key={p.id}>
                    <TableCell>
                      <span
                        className={`block h-2 w-2 rounded-full ${
                          isRunning ? "bg-primary" : p.lock ? "bg-warning" : "bg-success"
                        }`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {p.name}
                      {p.tags.length > 0 && (
                        <span className="ml-2 space-x-1">
                          {p.tags.map((t) => (
                            <Badge key={t} variant="outline" className="text-[10px]">
                              {t}
                            </Badge>
                          ))}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.folder || "—"}
                    </TableCell>
                    <TableCell className="mono text-xs">{proxyLabel(p.proxy_id)}</TableCell>
                    <TableCell className="mono text-xs text-muted-foreground">
                      {describeFingerprint(p.fingerprint)}
                    </TableCell>
                    <TableCell>
                      {isRunning ? (
                        <Badge className="bg-primary/15 text-primary">открыт у вас</Badge>
                      ) : p.lock ? (
                        <Badge className="bg-warning/15 text-warning">занят</Badge>
                      ) : (
                        <Badge className="bg-success/15 text-success">свободен</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {isRunning ? (
                        <Button variant="outline" size="sm" onClick={() => stop(p.id)}>
                          Закрыть
                        </Button>
                      ) : (
                        <Button size="sm" disabled={!!p.lock} onClick={() => start(p.id)}>
                          Старт
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditing({
                            id: p.id,
                            name: p.name,
                            folder: p.folder,
                            tags: p.tags.join(", "),
                            notes: p.notes,
                            proxyId: p.proxy_id ?? NO_PROXY,
                            fingerprint: p.fingerprint,
                          });
                          setOpen(true);
                        }}
                      >
                        Изменить
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          cloneFn({ data: { id: p.id } })
                            .then(invalidate)
                            .catch((e: Error) => toast.error(e.message))
                        }
                      >
                        Копия
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          delFn({ data: { id: p.id } })
                            .then(invalidate)
                            .catch((e: Error) => toast.error(e.message))
                        }
                      >
                        Удалить
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!profiles.isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center text-sm text-muted-foreground">
                    Профилей пока нет — создайте первый
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setEditing(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Профиль" : "Новый профиль"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="grid gap-4">
              <div className="space-y-2">
                <Label>Название</Label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Папка</Label>
                  <Input
                    value={editing.folder}
                    onChange={(e) => setEditing({ ...editing, folder: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Метки через запятую</Label>
                  <Input
                    value={editing.tags}
                    onChange={(e) => setEditing({ ...editing, tags: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Прокси</Label>
                <Select
                  value={editing.proxyId}
                  onValueChange={(v) => setEditing({ ...editing, proxyId: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Без прокси" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PROXY}>Без прокси</SelectItem>
                    {(proxies.data ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label} · {p.host}:{p.port}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Заметки</Label>
                <Textarea
                  rows={3}
                  value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                />
              </div>
              <div className="rounded-md border border-border bg-secondary/40 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Отпечаток Windows</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const country = (proxies.data ?? []).find(
                        (p) => p.id === editing.proxyId,
                      )?.country;
                      setEditing({
                        ...editing,
                        fingerprint: generateFingerprint(country ?? undefined),
                      });
                    }}
                  >
                    Сгенерировать заново
                  </Button>
                </div>
                <p className="mono mt-2 text-xs leading-relaxed text-muted-foreground">
                  {describeFingerprint(editing.fingerprint)}
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
