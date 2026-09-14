import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { desktop } from "@/lib/desktop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Search = {
  mode?: string | undefined;
  next?: string | undefined;
  desktop?: string | undefined;
  cb?: string | undefined;
};

export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    mode: typeof s["mode"] === "string" ? s["mode"] : undefined,
    next: typeof s["next"] === "string" ? s["next"] : undefined,
    desktop: typeof s["desktop"] === "string" ? s["desktop"] : undefined,
    cb: typeof s["cb"] === "string" ? s["cb"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Вход в Umbra" },
      { name: "description", content: "Вход и регистрация в системе управления профилями Umbra." },
      { property: "og:title", content: "Вход в Umbra" },
      { property: "og:description", content: "Доступ к вашим профилям, прокси и команде." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AuthPage,
});

function safeNext(next?: string) {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/app";
  return next;
}

function safeDesktopCallback(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.pathname !== "/cb" ||
      !/^[a-f0-9]{48}$/.test(url.searchParams.get("state") ?? "")
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function AuthPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">(
    search.mode === "signup" ? "signup" : "signin",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const next = safeNext(search.next);
  const isDesktopApp = !!desktop();
  const callback = safeDesktopCallback(search.cb);
  const handoffMode = !!callback && !isDesktopApp;

  function handoff(session: { access_token: string; refresh_token: string } | null) {
    if (!handoffMode || !callback || !session) return false;
    callback.searchParams.set("access_token", session.access_token);
    callback.searchParams.set("refresh_token", session.refresh_token);
    try {
      sessionStorage.removeItem("umbra:desktop-callback");
    } catch {
      /* ignore */
    }
    window.location.replace(callback.toString());
    return true;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}${next}` },
        });
        if (error) throw error;
        toast.success("Проверьте почту — мы отправили ссылку для подтверждения.");
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (handoff(data.session)) return;
        navigate({ to: next });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось выполнить вход");
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    const bridge = desktop();
    if (bridge) {
      // Открываем вход в системном браузере, где Google-аккаунт уже залогинен.
      await bridge.openAuth();
      toast.info("Продолжите вход в браузере — приложение подхватит его автоматически.");
      return;
    }
    setBusy(true);
    try {
      try {
        sessionStorage.setItem("umbra:next", next);
      } catch {
        /* ignore */
      }
      const result = await lovable.auth.signInWithOAuth("google", {
        // Managed Google login may normalize the return URL to the origin.
        // AuthSync keeps the desktop callback in sessionStorage across that round-trip.
        redirect_uri: window.location.origin,
      });
      if (result.error) {
        toast.error(
          result.error instanceof Error
            ? `Google: ${result.error.message}`
            : "Не удалось войти через Google",
        );
        return;
      }
      if (result.redirected) return;
      const { data } = await supabase.auth.getSession();
      if (handoff(data.session)) return;
      navigate({ to: next });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center grid-bg px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8">
        <Link to="/" className="mono text-sm text-muted-foreground hover:text-foreground">
          ← UMBRA
        </Link>
        <h1 className="mt-4 text-2xl font-semibold">
          {mode === "signin" ? "Вход" : "Регистрация"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "signin"
            ? "Войдите, чтобы управлять профилями и командой."
            : "Создайте владельца команды — сотрудников добавите позже."}
        </p>

        {handoffMode && (
          <div className="mono mt-4 rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
            Вход для приложения Umbra: после входа браузер сам вернёт вас в приложение.
          </div>
        )}
        {isDesktopApp && (
          <p className="mono mt-4 text-xs text-muted-foreground">
            Вход через Google откроется в вашем обычном браузере.
          </p>
        )}


        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Почта</Label>
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Пароль</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {mode === "signin" ? "Войти" : "Зарегистрироваться"}
          </Button>
        </form>

        <Button variant="outline" className="mt-3 w-full" onClick={google} disabled={busy}>
          Продолжить с Google
        </Button>

        <button
          type="button"
          className="mt-6 w-full text-center text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        >
          {mode === "signin" ? "Нет аккаунта? Зарегистрироваться" : "Уже есть аккаунт? Войти"}
        </button>
      </div>
    </div>
  );
}
