import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, Clock3, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { listProxies, proxyForCheck, recordProxyCheck, rotateProxyIp } from "@/lib/proxies.functions";
import { normalizeProxyCheck, performDesktopProxyCheck, proxyAddress } from "@/lib/proxy-input";
import { IpCountryFlag } from "@/components/ip-country-flag";
import { confirmRotation } from "@/lib/proxy-rotation";
import { desktop } from "@/lib/desktop";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type ProxyRow = Awaited<ReturnType<typeof listProxies>>[number];

/** Относительное время: «3 часа назад», «только что». */
export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return "";
  const diff = Math.round((time - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60], ["minute", 60], ["hour", 24], ["day", 7], ["week", 4.35], ["month", 12], ["year", Infinity],
  ];
  let amount = diff;
  for (const [unit, size] of units) {
    if (Math.abs(amount) < size) return new Intl.RelativeTimeFormat("ru-RU", { numeric: "auto" }).format(Math.round(amount), unit);
    amount = amount / size;
  }
  return "";
}

/** Проверка соединения и смена мобильного IP — общая логика для профилей и прокси. */
export function useProxyOps(teamId: string | undefined) {
  const qc = useQueryClient();
  const forCheck = useServerFn(proxyForCheck);
  const record = useServerFn(recordProxyCheck);
  const rotate = useServerFn(rotateProxyIp);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [completedRotations, setCompletedRotations] = useState<Record<string, { previousIp: string; newIp: string; changedAt: string }>>({});
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ["proxies"] }); };

  const checkMut = useMutation({
    mutationFn: async (id: string) => {
      const bridge = desktop();
      if (!teamId) throw new Error("Команда не загружена");
      if (!bridge?.checkProxy) throw new Error("Проверка прокси доступна в приложении Umbra для Windows");
      const result = await performDesktopProxyCheck({
        load: () => forCheck({ data: { id, teamId } }),
        check: (target) => bridge.checkProxy!(target),
        record: (value) => record({ data: { id, teamId, ...value } }),
      });
      setErrors((old) => {
        const next = { ...old };
        if (result.ok) delete next[id];
        else next[id] = result.error ?? "Прокси не прошёл проверку";
        return next;
      });
      if (!result.ok) throw new Error(result.error ?? "Прокси не прошёл проверку");
      return result;
    },
    onSuccess: (result) => toast.success("Прокси работает" + (result.ip ? ": " + result.ip : "")),
    onError: (error: Error) => toast.error(error.message),
    onSettled: invalidate,
  });

  const rotateMut = useMutation({
    mutationFn: async (id: string) => {
      const bridge = desktop();
      if (!teamId) throw new Error("Команда не загружена");
      if (!bridge?.checkProxy) throw new Error("Смена IP с проверкой доступна в приложении Umbra для Windows");
      setCompletedRotations((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      const target = await forCheck({ data: { id, teamId } });
      const probe = async () => {
        const response = await bridge.checkProxy!(target);
        if (!response.ok || !response.result) throw new Error("Не удалось проверить прокси в приложении");
        return normalizeProxyCheck(response.result);
      };
      const before = await probe();
      await record({ data: { id, teamId, ...before } });
      if (!before.ok || !before.ip) throw new Error("Текущий IP недоступен. Сначала восстановите подключение к прокси");
      const request = await rotate({ data: { id, teamId } });
      toast.info("Запрос отправлен. Ожидаю новый IP…");
      invalidate();
      return confirmRotation({
        previousIp: request.previousIp!,
        probe,
        record: async (result, final, confirmed) => {
          const saved = await record({ data: { id, teamId, ...result, rotationRequestedAt: request.requestedAt, rotationFinal: final, rotationConfirmed: confirmed } });
          invalidate();
          return saved;
        },
      });
    },
    onSuccess: (result, id) => {
      // Не ждём очередного опроса сервера: подтверждённый новый адрес уже
      // сохранён, поэтому сразу завершаем плашку «меняем IP» в текущей панели.
      if (teamId && result.rotationConfirmed && result.ip) {
        const changedAt = new Date().toISOString();
        const rows = qc.getQueryData<ProxyRow[]>(["proxies", teamId]);
        const previousIp = rows?.find((proxy) => proxy.id === id)?.rotationPreviousIp;
        if (previousIp) setCompletedRotations((current) => ({
          ...current,
          [id]: { previousIp, newIp: result.ip ?? previousIp, changedAt },
        }));
        qc.setQueryData<ProxyRow[]>(["proxies", teamId], (rows) => rows?.map((proxy) => proxy.id === id ? {
          ...proxy,
          last_check_ok: true,
          last_check_ip: result.ip ?? proxy.last_check_ip,
          last_check_latency_ms: result.latency ?? proxy.last_check_latency_ms,
          last_check_error: null,
          rotationStatus: "success",
          rotationNewIp: result.ip ?? proxy.rotationNewIp,
          rotationChangedAt: changedAt,
          rotationLastError: null,
        } : proxy));
        toast.success("Новый IP подтверждён: " + result.ip);
        return;
      }
      toast.info("IP обновлён. Смена уже завершена в другом окне");
    },
    onError: (error: Error) => toast.error(error.message),
    // После успеха кэш уже обновлён выше. Немедленная повторная загрузка могла
    // вернуть запаздывающий статус «changing» и снова включить индикатор.
    onSettled: (_result, error) => { if (error) invalidate(); },
  });

  return { checkMut, rotateMut, errors, completedRotations, busy: checkMut.isPending || rotateMut.isPending };
}

type Ops = ReturnType<typeof useProxyOps>;

/** Блок прокси в строке профиля: адрес, проверка, смена IP и история «был → стал». */
export function ProfileProxyCell({ proxy, ops, compact = false }: { proxy: ProxyRow | undefined; ops: Ops; compact?: boolean }) {
  if (!proxy) return <span className="text-xs text-muted-foreground">Без прокси</span>;
  const completed = ops.completedRotations[proxy.id];
  const checking = ops.checkMut.isPending && ops.checkMut.variables === proxy.id;
  const rotating = !completed && ((ops.rotateMut.isPending && ops.rotateMut.variables === proxy.id) || proxy.rotationStatus === "changing");
  const error = ops.errors[proxy.id] ?? proxy.last_check_error;
  const shownIp = completed?.newIp ?? proxy.last_check_ip;
  const previousIp = completed?.previousIp ?? proxy.rotationPreviousIp;
  const newIp = completed?.newIp ?? proxy.rotationNewIp;
  const dot = checking || rotating ? "bg-primary animate-pulse" : completed || proxy.last_check_ok === true ? "bg-success" : proxy.last_check_ok === false || error ? "bg-destructive" : "bg-primary";
  const hint = [
    `${proxy.label} · ${proxy.protocol.toUpperCase()}${proxy.country ? " · " + proxy.country : ""}`,
    proxyAddress(proxy.host, proxy.port),
    shownIp ? `IP ${shownIp}${proxy.last_check_latency_ms != null ? ` · ${proxy.last_check_latency_ms} мс` : ""}` : "IP не проверялся",
    proxy.last_checked_at ? `проверено ${relativeTime(proxy.last_checked_at)}` : "",
    previousIp ? `был ${previousIp}${newIp ? " → стал " + newIp : ""}` : "",
    proxy.rotationChangedAt ? `смена IP ${relativeTime(proxy.rotationChangedAt)}` : "",
    rotating ? "меняем IP, ждём подтверждения" : "",
    error ?? "",
  ].filter(Boolean).join("\n");

  if (compact) return <div className="min-w-0 space-y-0.5" title={hint}>
    <div className="flex min-w-0 items-center gap-1.5">
      <span className={`size-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{proxy.label}</span>
        <span className="mono ml-1 text-muted-foreground">{shownIp && <IpCountryFlag ip={shownIp} country={proxy.country} className="mr-1 font-sans text-sm" />}{shownIp ?? proxyAddress(proxy.host, proxy.port)}</span>
      </span>
      <Button variant="ghost" size="icon" className="size-6 shrink-0" title="Проверить соединение" aria-label={"Проверить прокси " + proxy.label}
        disabled={ops.busy} onClick={() => ops.checkMut.mutate(proxy.id)}>
        {checking ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
      </Button>
      {proxy.rotationUrlConfigured && <Button variant="ghost" size="icon" className="size-6 shrink-0" title="Сменить IP мобильного прокси" aria-label={"Сменить IP прокси " + proxy.label}
        disabled={ops.busy || proxy.rotationStatus === "changing"} onClick={() => ops.rotateMut.mutate(proxy.id)}>
        {rotating ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
      </Button>}
    </div>
    <div className="mono truncate pl-3.5 text-[11px] text-muted-foreground">
      {rotating
        ? proxy.rotationNewIp
          ? <>новый IP <span className="text-foreground/70">{proxy.rotationNewIp}</span>, подтверждаю…</>
          : <>меняем IP{proxy.rotationPreviousIp ? <> · был <span className="text-foreground/70">{proxy.rotationPreviousIp}</span></> : ""}…</>
        : previousIp
        ? <>был <span className="text-foreground/70">{previousIp}</span> → стал <span className="text-success">{newIp ?? shownIp ?? "—"}</span></>
        : "смены IP не было"}
    </div>
  </div>;

  return <div className="min-w-56 space-y-1">
    <div className="flex items-center gap-1">
      <span className="font-medium">{proxy.label}</span>
      <Badge variant="outline" className="text-[10px] uppercase">{proxy.protocol}</Badge>
      <div className="ml-auto flex shrink-0 gap-0.5">
        <Button variant="ghost" size="icon" className="size-7" title="Проверить соединение" aria-label={"Проверить прокси " + proxy.label}
          disabled={ops.busy} onClick={() => ops.checkMut.mutate(proxy.id)}>
          {checking ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
        </Button>
        {proxy.rotationUrlConfigured && <Button variant="ghost" size="icon" className="size-7" title="Сменить IP мобильного прокси" aria-label={"Сменить IP прокси " + proxy.label}
          disabled={ops.busy || proxy.rotationStatus === "changing"} onClick={() => ops.rotateMut.mutate(proxy.id)}>
          {rotating ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
        </Button>}
      </div>
    </div>
    <div className="mono break-all text-xs text-muted-foreground">{proxyAddress(proxy.host, proxy.port)}</div>
    <div className="flex flex-wrap items-center gap-1">
      {checking ? <span role="status" className="flex items-center gap-1 text-xs"><Loader2 className="size-3 animate-spin" />Проверяется</span>
        : proxy.last_check_ok === true ? <Badge className="bg-primary/15 text-primary">работает</Badge>
        : proxy.last_check_ok === false ? <Badge variant="destructive">ошибка</Badge>
        : <span className="text-xs text-muted-foreground">не проверялся</span>}
      {proxy.last_check_ip && <span className="mono break-all text-xs"><IpCountryFlag ip={proxy.last_check_ip} country={proxy.country} className="mr-1 font-sans text-sm" />{proxy.last_check_ip}{proxy.last_check_latency_ms != null ? ` · ${proxy.last_check_latency_ms} мс` : ""}</span>}
      {/* Мобильный IP меняется сам по себе: без времени проверки адрес в панели
          выглядит как текущий, хотя он лишь последний измеренный. */}
      {proxy.last_check_ip && proxy.last_checked_at && <span className="text-xs text-muted-foreground">проверено {relativeTime(proxy.last_checked_at)}</span>}
    </div>
    {proxy.rotationPreviousIp && <div className="mono break-all text-xs text-muted-foreground">
      Был: {proxy.rotationPreviousIp}{proxy.rotationNewIp ? " → стал: " + proxy.rotationNewIp : ""}
    </div>}
    {proxy.rotationChangedAt && <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <Clock3 className="size-3" />Смена IP {relativeTime(proxy.rotationChangedAt)}
    </div>}
    {rotating && <p role="status" className="text-xs text-warning">Меняем IP, ждём подтверждения…</p>}
    {error && <p role="status" className="break-words text-xs text-destructive">{error}</p>}
  </div>;
}

