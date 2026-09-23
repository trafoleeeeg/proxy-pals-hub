import { useId } from "react";
import { RefreshCw } from "lucide-react";
import { generateFingerprint, type Fingerprint, type FingerprintOS } from "@/lib/fingerprint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { fingerprintError } from "./profile-model";

export function ProfileFingerprint({ value, onChange, disabled = false, country }: {
  value: Fingerprint; onChange: (fp: Fingerprint) => void; disabled?: boolean; country?: string | null | undefined;
}) {
  const error = fingerprintError(value);
  const privacyModeId = useId();
  const aggressivePrivacyMode = value.aggressivePrivacyMode ?? true;
  function changeOS(os: FingerprintOS) {
    if (os === value.os) return;
    onChange({ ...generateFingerprint(country, os), language: value.language, languages: value.languages,
      timezone: value.timezone, ...(value.startUrl ? { startUrl: value.startUrl } : {}), webrtc: value.webrtc, doNotTrack: value.doNotTrack,
      aggressivePrivacyMode });
  }
  return <fieldset disabled={disabled} className="min-w-0 space-y-3 border-t border-border pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-medium">Отпечаток {value.os === "macos" ? "macOS" : "Windows"}</h3>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChange({ ...generateFingerprint(country, value.os), ...(value.startUrl ? { startUrl: value.startUrl } : {}), webrtc: value.webrtc, aggressivePrivacyMode })}>
        <RefreshCw className="size-4" /> Новый отпечаток
      </Button>
    </div>
    <p className="text-xs text-muted-foreground">User-Agent и Client Hints согласуются с ОС профиля и установленным Chromium. Подмена шрифтов и шум WebGL не поддерживаются; Web Workers и отдельные фреймы могут отличаться. Отпечаток macOS на Windows не эмулирует настоящее устройство Mac и не гарантирует нераспознаваемость.</p>
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={privacyModeId}>Агрессивная блокировка API</Label>
        <Switch id={privacyModeId} checked={aggressivePrivacyMode} onCheckedChange={(checked) => onChange({ ...value, aggressivePrivacyMode: checked })} disabled={disabled} />
      </div>
      <p className="text-xs text-muted-foreground">{aggressivePrivacyMode
        ? "Строгий режим ограничивает аппаратные API. Сайты могут заметить недоступность функций."
        : "Обычный режим снимает агрессивную блокировку API. В стандартном Electron доступные API могут раскрыть реальные GPU и шрифты устройства; согласованная подмена уровня Octo здесь не гарантируется."}</p>
    </div>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="grid gap-2"><Label htmlFor="profile-os">Операционная система</Label><Select disabled={disabled} value={value.os} onValueChange={(os) => changeOS(os as FingerprintOS)}>
        <SelectTrigger id="profile-os"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="windows">Windows</SelectItem><SelectItem value="macos">macOS · Apple Silicon</SelectItem></SelectContent>
      </Select></div>
      <div className="grid gap-2"><Label htmlFor="profile-webrtc">Защита WebRTC</Label><Select disabled={disabled} value={value.webrtc} onValueChange={(webrtc) => onChange({ ...value, webrtc: webrtc as Fingerprint["webrtc"] })}>
        <SelectTrigger id="profile-webrtc"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="disabled">Отключён в страницах</SelectItem><SelectItem value="proxy">Запрет прямого UDP</SelectItem></SelectContent>
      </Select></div>
      <Label className="grid gap-2">Часовой пояс<Input value={value.timezone} onChange={(e) => onChange({ ...value, timezone: e.target.value })} placeholder="Europe/Berlin" /></Label>
      <Label className="grid gap-2">Основной язык<Input value={value.language} onChange={(e) => onChange({ ...value, language: e.target.value, languages: [e.target.value, ...value.languages.filter((lang) => lang !== value.language && lang !== e.target.value)] })} placeholder="de-DE" /></Label>
      <Label className="grid gap-2">Ширина экрана<Input type="number" min={320} max={7680} value={value.screen?.width ?? ""} onChange={(e) => onChange({ ...value, screen: { ...value.screen, width: Number(e.target.value) } })} /></Label>
      <Label className="grid gap-2">Высота экрана<Input type="number" min={240} max={4320} value={value.screen?.height ?? ""} onChange={(e) => onChange({ ...value, screen: { ...value.screen, height: Number(e.target.value) } })} /></Label>
      <Label className="grid gap-2">Ядра процессора<Input type="number" min={1} max={128} value={value.hardwareConcurrency} onChange={(e) => onChange({ ...value, hardwareConcurrency: Number(e.target.value) })} /></Label>
      <div className="grid gap-2"><Label htmlFor="profile-memory">Память, ГБ</Label><Select disabled={disabled} value={String(value.deviceMemory)} onValueChange={(memory) => onChange({ ...value, deviceMemory: Number(memory) })}>
        <SelectTrigger id="profile-memory"><SelectValue /></SelectTrigger><SelectContent>{[1, 2, 4, 8].map((memory) => <SelectItem key={memory} value={String(memory)}>{memory}</SelectItem>)}</SelectContent>
      </Select></div>
    </div>
    <Label className="grid gap-2">User-Agent<Input value={value.userAgent} maxLength={1024} onChange={(e) => onChange({ ...value, userAgent: e.target.value })} className="font-mono text-xs" /></Label>
    <Label className="grid gap-2">Стартовый адрес<Input type="url" value={value.startUrl ?? ""} onChange={(e) => onChange({ ...value, startUrl: e.target.value })} placeholder="https://example.com" /></Label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </fieldset>;
}
