import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useRef, useState, type ClipboardEvent } from "react";
import { Activity, CheckCheck, ClipboardPaste, Clock3, Link2, Loader2, Pencil, Plus, RotateCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/lib/useWorkspace";
import { usePermissions } from "@/lib/usePermissions";
import { listProxies, saveProxy, deleteProxy, importProxies, checkProxy, proxyForCheck, recordProxyCheck, rotateProxyIp } from "@/lib/proxies.functions";
import {
  PROXY_LIMITS, ProxyCheckQueue, parseProxyPort, performDesktopProxyCheck,
  proxyAddress, validateProxyInput, normalizeProxyCheck, parseProxyBundle,
} from "@/lib/proxy-input";
import { IpCountryFlag } from "@/components/ip-country-flag";
import { confirmRotation } from "@/lib/proxy-rotation";
import type { PasswordAction, ProxyImportIssue, ProxyProtocol, RotationAction } from "@/lib/proxy-input";
import { desktop } from "@/lib/desktop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/app/proxies")({ component: ProxiesPage });

const emptyForm = {
  id: undefined as string | undefined, label: "", protocol: "http" as ProxyProtocol,
  host: "", port: "", username: "", password: "", country: "",
  passwordAction: "replace" as PasswordAction, rotationUrl: "", rotationAction: "clear" as RotationAction,
};
type ProxyRow = Awaited<ReturnType<typeof listProxies>>[number];

function proxyTime(value: string | null) {
  if (!value) return "";
  try { return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
  catch { return ""; }
}

export function ProxiesPage() {
  const { data: ws } = useWorkspace();
  const qc = useQueryClient();
  const list = useServerFn(listProxies);
  const save = useServerFn(saveProxy);
  const remove = useServerFn(deleteProxy);
  const bulk = useServerFn(importProxies);
  const check = useServerFn(checkProxy);
  const forCheck = useServerFn(proxyForCheck);
  const record = useServerFn(recordProxyCheck);
  const rotate = useServerFn(rotateProxyIp);
  const [open, setOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importProtocol, setImportProtocol] = useState<ProxyProtocol>("http");
  const [importIssues, setImportIssues] = useState<ProxyImportIssue[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  const queue = useRef(new ProxyCheckQueue(3));
  const { can, isError: permissionsError } = usePermissions(ws?.teamId);
  const canManageProxies = can("proxy.manage");

  const proxies = useQuery({
    queryKey: ["proxies", ws?.teamId],
    queryFn: () => list({ data: { teamId: ws!.teamId } }),
    enabled: !!ws?.teamId,
    refetchInterval: (query) => query.state.data?.some((proxy) => proxy.rotationStatus === "changing") ? 5000 : false,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["proxies"] });
  const teamId = () => {
    if (!ws?.teamId) throw new Error("Команда ещё загружается");
    return ws.teamId;
  };
  async function readClipboard() {
    const bridge = desktop();
    return bridge?.readProxyClipboard ? bridge.readProxyClipboard() : navigator.clipboard.readText();
  }
  function fillFromBundle(text: string): boolean {
    const parsed = parseProxyBundle(text);
    if (!parsed) return false;
    setForm((current) => ({
      ...current, label: current.label || parsed.label, protocol: parsed.protocol,
      host: parsed.host, port: String(parsed.port), username: parsed.username, password: parsed.password,
      country: "", passwordAction: parsed.password ? "replace" : "clear",
      rotationUrl: parsed.rotationUrl,
      rotationAction: parsed.rotationUrl ? "replace" : current.id ? "preserve" : "clear",
    }));
    toast.success("Поля прокси заполнены. Проверьте их и нажмите «Сохранить».");
    return true;
  }
  function pasteIntoForm(event: ClipboardEvent<HTMLFormElement>) {
    const text = event.clipboardData.getData("text");
    try {
      if (fillFromBundle(text)) event.preventDefault();
    } catch (error) {
      event.preventDefault();
      toast.error(error instanceof Error ? error.message : "Не удалось распознать прокси");
    }
  }
  async function pasteIntoFormFromClipboard() {
    try {
      const text = await readClipboard();
      if (!text) { toast.info("Буфер обмена пуст"); return; }
      if (!fillFromBundle(text)) toast.error("В буфере не найден адрес прокси");
    } catch (error) {
      toast.error(error instanceof Error && error.message.startsWith("Не удалось распознать") ? error.message : "Не удалось прочитать настройки прокси из буфера");
    }
  }
  async function pasteImport() {
    try {
      const value = await readClipboard();
      if (!value) { toast.info("Буфер обмена пуст"); return; }
      if (new TextEncoder().encode(value).length > PROXY_LIMITS.importBytes) throw new Error();
      const parsed = parseProxyBundle(value);
      if (parsed && (parsed.rotationUrl || /^\s*(?:socks5|https?|socks)\s*:\s+/i.test(value))) {
        fillFromBundle(value); setImportOpen(false); setOpen(true); return;
      }
      setImportText(value);
      setImportIssues([]);
      importMut.reset();
    } catch { toast.error("Не удалось прочитать буфер обмена. Разрешите доступ и повторите"); }
  }
  const saveMut = useMutation({
    mutationFn: () => {
      const data = validateProxyInput({
        ...form, teamId: teamId(), port: parseProxyPort(form.port),
        passwordAction: !form.id && !form.password ? "clear" : form.passwordAction,
      });
      return save({ data });
    },
    onSuccess: async () => {
      toast.success("Прокси сохранён");
      setOpen(false);
      setForm(emptyForm);
      await invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const importMut = useMutation({
    mutationFn: () => bulk({ data: { teamId: teamId(), text: importText, protocol: importProtocol } }),
    onSuccess: async (result) => {
      setImportIssues(result.issues);
      if (result.issues.length) {
        toast.error("Импорт не выполнен. Исправьте отмеченные строки");
        return;
      }
      toast.success(`Добавлено прокси: ${result.added}`);
      setImportOpen(false);
      setImportText("");
      await invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const removeMut = useMutation({
    mutationFn: (id: string) => remove({ data: { id, teamId: teamId() } }),
    onSuccess: async () => { toast.success("Прокси удалён"); await invalidate(); },
    onError: (error: Error) => toast.error(error.message),
  });

  const checkMut = useMutation({
    mutationFn: async (ids: string[]) => {
      const selectedTeam = teamId();
      const bridge = desktop();
      if (!bridge?.checkProxy) {
        const firstId = ids[0];
        if (firstId) {
          const result = await check({ data: { id: firstId, teamId: selectedTeam } });
          toast.info(result.error);
        }
        return;
      }
      setChecking(new Set(ids));
      const results = await Promise.all(ids.map((id) => queue.current.run(id, async () => {
        try {
          const result = await performDesktopProxyCheck({
            load: () => forCheck({ data: { id, teamId: selectedTeam } }),
            check: (target) => bridge.checkProxy!(target),
            record: (result) => record({ data: { id, teamId: selectedTeam, ...result } }),
          });
          setCheckErrors((old) => {
            const next = { ...old };
            if (result.ok) delete next[id];
            else next[id] = result.error ?? "Прокси не прошёл проверку";
            return next;
          });
          return result.ok;
        } catch (error) {
          setCheckErrors((old) => ({ ...old, [id]: error instanceof Error ? error.message : "Проверка не выполнена" }));
          return false;
        } finally {
          setChecking((old) => { const next = new Set(old); next.delete(id); return next; });
        }
      })));
      const passed = results.filter(Boolean).length;
      if (passed === results.length) toast.success(`Проверено: ${passed}. Все прокси работают`);
      else toast.error(`Работают: ${passed} из ${results.length}. Ошибки показаны в списке`);
    },
    onSettled: async () => { setChecking(new Set()); await invalidate(); },
    onError: () => toast.error("Не удалось выполнить проверку. Проверьте доступ и подключение"),
  });
  const rotateMut = useMutation({
    mutationFn: async (id: string) => {
      const bridge = desktop();
      if (!bridge?.checkProxy) throw new Error("Смена IP с проверкой доступна в приложении Windows");
      const selectedTeam = teamId();
      const target = await forCheck({ data: { id, teamId: selectedTeam } });
      const probe = async () => {
        const response = await bridge.checkProxy!(target);
        if (!response.ok || !response.result) throw new Error("Не удалось проверить прокси в приложении");
        return normalizeProxyCheck(response.result);
      };
      const before = await probe();
      await record({ data: { id, teamId: selectedTeam, ...before } });
      if (!before.ok || !before.ip) throw new Error("Текущий IP недоступен. Сначала восстановите подключение к прокси");
      const request = await rotate({ data: { id, teamId: selectedTeam } });
      toast.info("Запрос отправлен. Ожидаю новый IP…");
      void invalidate();
      return confirmRotation({
        previousIp: request.previousIp!,
        probe,
        record: async (result, final, confirmed) => {
          const saved = await record({ data: { id, teamId: selectedTeam, ...result, rotationRequestedAt: request.requestedAt, rotationFinal: final, rotationConfirmed: confirmed } });
          void invalidate();
          return saved;
        },
      });
    },
    onSuccess: (result) => result.rotationConfirmed
      ? toast.success("Новый IP подтверждён: " + result.ip)
      : toast.info("IP обновлён. Смена уже завершена в другом окне"),
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => invalidate(),
  });

  const edit = (proxy?: ProxyRow) => {
    saveMut.reset();
    setForm(proxy ? {
      id: proxy.id, label: proxy.label, protocol: proxy.protocol, host: proxy.host,
      port: String(proxy.port), username: proxy.username ?? "", password: "",
      country: proxy.country ?? "", passwordAction: "preserve", rotationUrl: "", rotationAction: "preserve",
    } : emptyForm);
    setOpen(true);
  };
  const closeForm = (value: boolean) => {
    if (saveMut.isPending) return;
    setOpen(value);
    if (!value) setForm(emptyForm);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Прокси</h1>
        {canManageProxies && <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => checkMut.mutate((proxies.data ?? []).map((p) => p.id))}
            disabled={checkMut.isPending || rotateMut.isPending || !proxies.data?.length}>
            {checkMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <CheckCheck className="size-4" />}
            Проверить все
          </Button>
          <Button variant="outline" onClick={() => { importMut.reset(); setImportIssues([]); setImportOpen(true); }}>
            <Upload className="size-4" />Импорт
          </Button>
          <Button onClick={() => edit()}><Plus className="size-4" />Добавить прокси</Button>
        </div>}
      </div>
      {permissionsError && <p role="alert" className="mt-3 text-sm text-destructive">Не удалось загрузить ваши права. Обновите страницу и повторите попытку.</p>}

      <Dialog open={importOpen} onOpenChange={(value) => {
        if (importMut.isPending) return;
        setImportOpen(value);
        if (!value) { setImportText(""); setImportIssues([]); }
      }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader><DialogTitle>Импорт прокси</DialogTitle></DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted-foreground">Вставьте список строкой или целым столбцом.</p><Button type="button" variant="outline" size="sm" onClick={() => { void pasteImport(); }}><ClipboardPaste className="size-4" />Вставить из буфера</Button></div>
          <Label htmlFor="proxy-import-protocol">Тип по умолчанию</Label>
          <Select value={importProtocol} disabled={importMut.isPending}
            onValueChange={(value) => { setImportProtocol(value as ProxyProtocol); setImportIssues([]); }}>
            <SelectTrigger id="proxy-import-protocol"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="http">HTTP</SelectItem><SelectItem value="https">HTTPS</SelectItem>
              <SelectItem value="socks5">SOCKS5</SelectItem>
            </SelectContent>
          </Select>
          <Label htmlFor="proxy-import-text">Список прокси</Label>
          <Textarea id="proxy-import-text" rows={10} value={importText} maxLength={PROXY_LIMITS.importBytes}
            disabled={importMut.isPending} spellCheck={false} autoComplete="off"
            onPaste={(event) => {
              const text = event.clipboardData.getData("text");
              try {
                const parsed = parseProxyBundle(text);
                if (parsed && (parsed.rotationUrl || /^\s*(?:socks5|https?|socks)\s*:\s+/i.test(text))) {
                  event.preventDefault(); fillFromBundle(text); setImportOpen(false); setOpen(true);
                }
              } catch (error) {
                event.preventDefault();
                toast.error(error instanceof Error ? error.message : "Не удалось распознать прокси");
              }
            }}
            onChange={(event) => { setImportText(event.target.value); setImportIssues([]); importMut.reset(); }}
            placeholder={"socks5://user:pass@[2001:db8::1]:1080\nproxy.example:8080:user:pass"}
            className="mono text-xs" aria-invalid={!!importIssues.length || importMut.isError} />
          {!!importIssues.length && <ul role="alert" className="max-h-48 space-y-1 overflow-auto text-sm text-destructive">
            {importIssues.map((issue) => <li key={issue.line}>Строка {issue.line}: {issue.message}</li>)}
          </ul>}
          {importMut.isError && <p role="alert" className="text-sm text-destructive">{importMut.error.message}</p>}
          <DialogFooter><Button onClick={() => importMut.mutate()} disabled={importMut.isPending || !importText.trim()}>
            {importMut.isPending && <Loader2 className="size-4 animate-spin" />}Добавить
          </Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={closeForm}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader><DialogTitle>{form.id ? "Редактирование прокси" : "Новый прокси"}</DialogTitle></DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
            <span className="text-muted-foreground">Вставьте строку прокси и ссылку смены IP в любое поле — поля заполнятся сами.</span>
            <Button type="button" variant="outline" size="sm" disabled={saveMut.isPending} onClick={() => void pasteIntoFormFromClipboard()}><ClipboardPaste className="size-4" />Вставить из буфера</Button>
          </div>
          <form onPaste={pasteIntoForm} onSubmit={(event) => { event.preventDefault(); if (!saveMut.isPending) saveMut.mutate(); }}>
            <fieldset disabled={saveMut.isPending} className="grid min-w-0 gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="proxy-label">Название</Label>
                <Input id="proxy-label" value={form.label} maxLength={PROXY_LIMITS.label}
                  onChange={(event) => setForm({ ...form, label: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="proxy-protocol">Тип</Label>
                <Select value={form.protocol} onValueChange={(value) => setForm({ ...form, protocol: value as ProxyProtocol })}>
                  <SelectTrigger id="proxy-protocol"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">HTTP</SelectItem><SelectItem value="https">HTTPS</SelectItem>
                    <SelectItem value="socks5">SOCKS5</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="proxy-host">Адрес</Label>
                <Input id="proxy-host" value={form.host} maxLength={PROXY_LIMITS.host + 2} required
                  onChange={(event) => setForm({ ...form, host: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="proxy-port">Порт</Label>
                <Input id="proxy-port" value={form.port} inputMode="numeric" pattern="[0-9]{1,5}" maxLength={5} required
                  onChange={(event) => setForm({ ...form, port: event.target.value })} />
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="proxy-username">Логин</Label>
                <Input id="proxy-username" value={form.username} maxLength={PROXY_LIMITS.credentialBytes} autoComplete="off"
                  onChange={(event) => setForm({ ...form, username: event.target.value })} />
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor="proxy-password">Пароль</Label>
                {form.id && <Select value={form.passwordAction}
                  onValueChange={(value) => setForm({ ...form, passwordAction: value as PasswordAction, password: "" })}>
                  <SelectTrigger aria-label="Действие с паролем"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="preserve">Сохранить текущий</SelectItem>
                    <SelectItem value="replace">Заменить</SelectItem>
                    <SelectItem value="clear">Удалить пароль</SelectItem>
                  </SelectContent>
                </Select>}
                <Input id="proxy-password" type="password" value={form.password} autoComplete="new-password"
                  disabled={form.passwordAction !== "replace"} maxLength={PROXY_LIMITS.credentialBytes}
                  required={!!form.id && form.passwordAction === "replace"}
                  onChange={(event) => setForm({ ...form, password: event.target.value })} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="proxy-rotation-url" className="flex items-center gap-2"><Link2 className="size-4" />Ссылка смены IP для мобильного прокси</Label>
                {form.id && <Select value={form.rotationAction} onValueChange={(value) => setForm({ ...form, rotationAction: value as RotationAction, rotationUrl: "" })}>
                  <SelectTrigger aria-label="Действие со ссылкой смены IP"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="preserve">Сохранить текущую</SelectItem><SelectItem value="replace">Заменить ссылку</SelectItem><SelectItem value="clear">Удалить ссылку</SelectItem></SelectContent>
                </Select>}
                {!form.id && <Select value={form.rotationAction} onValueChange={(value) => setForm({ ...form, rotationAction: value as RotationAction, rotationUrl: "" })}>
                  <SelectTrigger aria-label="Настройка ссылки смены IP"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="clear">Не настраивать</SelectItem><SelectItem value="replace">Добавить ссылку</SelectItem></SelectContent>
                </Select>}
                <Input id="proxy-rotation-url" type="url" value={form.rotationUrl} disabled={form.rotationAction !== "replace"} maxLength={2048} autoComplete="off" placeholder="https://provider.example/rotate?token=…"
                  onChange={(event) => setForm({ ...form, rotationUrl: event.target.value, rotationAction: event.target.value ? "replace" : form.rotationAction })} />
                <p className="text-xs text-muted-foreground">Ссылка хранится зашифрованной. После запроса Umbra проверит прокси и покажет старый и новый IP.</p>
              </div>
            </fieldset>
            {saveMut.isError && <p role="alert" className="mt-4 text-sm text-destructive">{saveMut.error.message}</p>}
            <DialogFooter className="mt-4"><Button type="submit" disabled={saveMut.isPending || !ws?.teamId}>
              {saveMut.isPending && <Loader2 className="size-4 animate-spin" />}Сохранить
            </Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <div className="mt-6">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Название</TableHead><TableHead>Тип</TableHead><TableHead>Адрес</TableHead>
            <TableHead>Проверка и IP</TableHead><TableHead>Смена IP</TableHead><TableHead><span className="sr-only">Действия</span></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(proxies.data ?? []).map((proxy) => <TableRow key={proxy.id}>
              <TableCell className="max-w-52 break-words font-medium">{proxy.label}</TableCell>
              <TableCell className="mono text-xs uppercase">{proxy.protocol}</TableCell>
              <TableCell className="mono max-w-64 break-all text-xs">{proxyAddress(proxy.host, proxy.port)}</TableCell>
              <TableCell className="min-w-36 max-w-72">
                {checking.has(proxy.id) ? <span role="status" className="flex items-center gap-2 text-xs">
                  <Loader2 className="size-3 animate-spin" />Проверяется
                </span> : proxy.last_check_ok === true ? <Badge className="bg-primary/15 text-primary">работает</Badge>
                  : proxy.last_check_ok === false ? <Badge variant="destructive">ошибка</Badge>
                  : <span className="text-xs text-muted-foreground">не проверялся</span>}
                {proxy.last_check_ip && <div className="mono mt-1 break-all text-xs"><IpCountryFlag ip={proxy.last_check_ip} country={proxy.country} className="mr-1.5 font-sans text-base" />{proxy.last_check_ip}
                  {proxy.last_check_latency_ms != null ? ` · ${proxy.last_check_latency_ms} мс` : ""}</div>}
                {(checkErrors[proxy.id] || proxy.last_check_error) && <p role="status" className="mt-1 break-words text-xs text-destructive">
                  {checkErrors[proxy.id] || proxy.last_check_error}
                </p>}
              </TableCell>
              <TableCell className="min-w-44 max-w-64">
                {proxy.rotationUrlConfigured ? <>
                  <Badge variant="outline" className={proxy.rotationStatus === "changing" ? "text-warning" : proxy.rotationStatus === "error" ? "text-destructive" : "text-primary"}>
                    {proxy.rotationStatus === "changing" ? "меняем IP" : proxy.rotationStatus === "error" ? "ошибка смены" : proxy.rotationStatus === "success" ? "смена подтверждена" : "готово к смене"}
                  </Badge>
                  {proxy.rotationPreviousIp && <div className="mono mt-1 break-all text-xs text-muted-foreground">Был: {proxy.rotationPreviousIp}</div>}
                  {proxy.rotationStatus === "success" && proxy.rotationNewIp && <div className="mono break-all text-xs">Стал: {proxy.rotationNewIp}</div>}
                  {proxy.rotationChangedAt && <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="size-3" />Последняя смена: {proxyTime(proxy.rotationChangedAt)}</div>}
                  {proxy.rotationStatus === "changing" && proxy.rotationRequestedAt && <p className="mt-1 text-xs text-muted-foreground">Запрос: {proxyTime(proxy.rotationRequestedAt)}</p>}
                  {proxy.rotationLastError && <p role="status" className="mt-1 text-xs text-destructive">{proxy.rotationLastError}</p>}
                </> : <span className="text-xs text-muted-foreground">не настроена</span>}
              </TableCell>
              <TableCell className="text-right">
                {canManageProxies && <div className="flex justify-end gap-1">
                  {proxy.rotationUrlConfigured && <Button variant="ghost" size="icon" title="Сменить IP мобильного прокси" aria-label="Сменить IP мобильного прокси"
                    disabled={!desktop()?.checkProxy || rotateMut.isPending || checkMut.isPending || removeMut.isPending || proxy.rotationStatus === "changing"} onClick={() => rotateMut.mutate(proxy.id)}>
                    {rotateMut.isPending && rotateMut.variables === proxy.id ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                  </Button>}
                  <Button variant="ghost" size="icon" title="Проверить прокси" aria-label="Проверить прокси"
                    disabled={checkMut.isPending || rotateMut.isPending || removeMut.isPending} onClick={() => checkMut.mutate([proxy.id])}>
                    <Activity className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon" title="Редактировать прокси" aria-label="Редактировать прокси"
                    disabled={checkMut.isPending || rotateMut.isPending || removeMut.isPending} onClick={() => edit(proxy)}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon" title="Удалить прокси" aria-label="Удалить прокси"
                    disabled={checkMut.isPending || rotateMut.isPending || removeMut.isPending} onClick={() => removeMut.mutate(proxy.id)}>
                    {removeMut.isPending && removeMut.variables === proxy.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  </Button>
                </div>}
              </TableCell>
            </TableRow>)}
            {(proxies.isPending || proxies.isError || !proxies.data?.length) && <TableRow>
              <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                {proxies.isPending ? "Загрузка прокси..." : proxies.isError ? "Не удалось загрузить прокси" : "Пока нет ни одного прокси"}
                {proxies.isError && <Button variant="ghost" onClick={() => { void proxies.refetch(); }}>Повторить</Button>}
              </TableCell>
            </TableRow>}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

