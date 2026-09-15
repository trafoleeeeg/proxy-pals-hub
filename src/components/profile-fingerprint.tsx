import { RefreshCw } from "lucide-react";
import { generateFingerprint, type Fingerprint } from "@/lib/fingerprint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fingerprintError } from "./profile-model";

export function ProfileFingerprint({ value, onChange, disabled = false, country }: {
  value: Fingerprint; onChange: (fp: Fingerprint) => void; disabled?: boolean; country?: string | null | undefined;
}) {
  const error = fingerprintError(value);
  return <fieldset disabled={disabled} className="min-w-0 space-y-3 border-t border-border pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-medium">Отпечаток Windows</h3>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChange(generateFingerprint(country))}>
        <RefreshCw className="size-4" /> Новый отпечаток
      </Button>
    </div>
    <p className="text-xs text-muted-foreground">Версия Chrome в User-Agent будет согласована с установленным движком. Подмена шрифтов и шум WebGL не поддерживаются. Изменения отпечатка в Electron не гарантируют защиту от обнаружения; Web Workers и отдельные фреймы могут отличаться.</p>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
