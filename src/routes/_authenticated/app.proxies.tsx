import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/lib/useWorkspace";
import {
  listProxies,
  saveProxy,
  deleteProxy,
  importProxies,
  checkProxy,
  proxyForCheck,
  recordProxyCheck,
} from "@/lib/proxies.functions";
import { desktop } from "@/lib/desktop";
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

export const Route = createFileRoute("/_authenticated/app/proxies")({
  component: ProxiesPage,
});

type Protocol = "http" | "https" | "socks5";

function ProxiesPage() {
  const { data: ws } = useWorkspace();
  const qc = useQueryClient();
  const list = useServerFn(listProxies);
  const save = useServerFn(saveProxy);
  const remove = useServerFn(deleteProxy);
  const bulk = useServerFn(importProxies);
  const check = useServerFn(checkProxy);
  const forCheck = useServerFn(proxyForCheck);
  const record = useServerFn(recordProxyCheck);

  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [form, setForm] = useState({
    label: "",
    protocol: "http" as Protocol,
    host: "",
    port: "",
    username: "",
    password: "",
    country: "",
  });

  const proxies = useQuery({
    queryKey: ["proxies", ws?.teamId],
    queryFn: () => list({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["proxies"] });

  const saveMut = useMutation({
    mutationFn: () => {
      if (!ws?.teamId) throw new Error("Команда ещё загружается, попробуйте через секунду");
      return save({
        data: {
          teamId: ws.teamId,
          label: form.label || `${form.host}:${form.port}`,
          protocol: form.protocol,
          host: form.host,
          port: Number(form.port),
          username: form.username || undefined,
          password: form.password || undefined,
          country: form.country || undefined,
        },
      });
    },
    onSuccess: () => {
      toast.success("Прокси сохранён");
      setOpen(false);
      setForm({
        label: "",
        protocol: "http",
        host: "",
        port: "",
        username: "",
        password: "",
        country: "",
      });
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const importMut = useMutation({
    mutationFn: () => {
      if (!ws?.teamId) throw new Error("Команда ещё загружается, попробуйте через секунду");
      return bulk({ data: { teamId: ws.teamId, text: importText } });
    },
    onSuccess: (r) => {
      toast.success(`Добавлено прокси: ${r.added}`);
      setImportOpen(false);
      setImportText("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const checkMut = useMutation({
    mutationFn: (id: string) => check({ data: { id } }),
    onSuccess: (r) => {
      if (r.ok) toast.success(`Работает · ${r.ip ?? ""} ${r.country ?? ""}`.trim());
      else toast.error(r.error ?? "Прокси не отвечает");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Прокси</h1>
          <p className="text-sm text-muted-foreground">
            Пароли хранятся в зашифрованном виде и не показываются после сохранения.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">Импорт списком</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Импорт прокси</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                По одному в строке, например: <span className="mono">socks5://user:pass@1.2.3.4:1080</span>{" "}
                или <span className="mono">1.2.3.4:8080:user:pass</span>
              </p>
              <Textarea
                rows={10}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                className="mono text-xs"
              />
              <DialogFooter>
                <Button onClick={() => importMut.mutate()} disabled={importMut.isPending}>
                  Добавить
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>Добавить прокси</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Новый прокси</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label>Название</Label>
                  <Input
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                    placeholder="Например, Германия 1"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Тип</Label>
                  <Select
                    value={form.protocol}
                    onValueChange={(v) => setForm({ ...form, protocol: v as Protocol })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="https">HTTPS</SelectItem>
                      <SelectItem value="socks5">SOCKS5</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Страна</Label>
                  <Input
                    value={form.country}
                    maxLength={2}
                    placeholder="DE"
                    onChange={(e) => setForm({ ...form, country: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Адрес</Label>
                  <Input
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Порт</Label>
                  <Input
                    value={form.port}
                    inputMode="numeric"
                    onChange={(e) => setForm({ ...form, port: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Логин</Label>
                  <Input
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Пароль</Label>
                  <Input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => saveMut.mutate()}
                  disabled={saveMut.isPending || !form.host || !form.port}
                >
                  Сохранить
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Название</TableHead>
              <TableHead>Тип</TableHead>
              <TableHead>Адрес</TableHead>
              <TableHead>Страна</TableHead>
              <TableHead>Проверка</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(proxies.data ?? []).map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.label}</TableCell>
                <TableCell className="mono text-xs uppercase">{p.protocol}</TableCell>
                <TableCell className="mono text-xs">
                  {p.host}:{p.port}
                  {p.username ? ` · ${p.username}` : ""}
                </TableCell>
                <TableCell className="mono text-xs">{p.country ?? "—"}</TableCell>
                <TableCell>
                  {p.last_check_ok === true ? (
                    <Badge className="bg-primary/15 text-primary">работает</Badge>
                  ) : p.last_check_ok === false ? (
                    <Badge variant="destructive">ошибка</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">не проверялся</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => checkMut.mutate(p.id)}
                    disabled={checkMut.isPending}
                  >
                    Проверить
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      remove({ data: { id: p.id } })
                        .then(invalidate)
                        .catch((e: Error) => toast.error(e.message))
                    }
                  >
                    Удалить
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!proxies.isLoading && (proxies.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                  Пока нет ни одного прокси
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
