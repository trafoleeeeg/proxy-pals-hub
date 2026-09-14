import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { desktop } from "@/lib/desktop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Search = { mode?: string | undefined; next?: string | undefined; desktop?: string | undefined };

export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    mode: typeof s["mode"] === "string" ? s["mode"] : undefined,
    next: typeof s["next"] === "string" ? s["next"] : undefined,
    desktop: typeof s["desktop"] === "string" ? s["desktop"] : undefined,
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

function AuthPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">(
    search.mode === "signup" ? "signup" : "signin",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState(false);

  const next = safeNext(search.next);
  const isDesktopApp = !!desktop();
  const handoffMode = search.desktop === "1" && !isDesktopApp;

  // Приложение получило токены из системного браузера — входим внутри приложения.
  useEffect(() => {
    const bridge = desktop();
    if (!bridge) return;
    return bridge.onAuthTokens(async (tokens) => {
      const { error } = await supabase.auth.setSession(tokens);
      if (error) {
        toast.error("Не удалось перенести вход из браузера");
        return;
      }
      navigate({ to: next });
    });
  }, [navigate, next]);

  // Обычный браузер, открытый приложением: после входа отдаём сессию в приложение.
  useEffect(() => {
    if (!handoffMode) return;
    let done = false;
    const hand = (session: { access_token: string; refresh_token: string } | null) => {
      if (!session || done) return;
      done = true;
      setHandoff(true);
      window.location.href = `umbra://auth#access_token=${encodeURIComponent(
        session.access_token,
      )}&refresh_token=${encodeURIComponent(session.refresh_token)}`;
    };
    supabase.auth.getSession().then(({ data }) => hand(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, session) => hand(session));
    return () => data.subscription.unsubscribe();
  }, [handoffMode]);

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
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
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
        redirect_uri: handoffMode
          ? `${window.location.origin}/auth?desktop=1`
          : window.location.origin,
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
          <p className="mono mt-4 rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
            {handoff
              ? "Вход выполнен — возвращаемся в приложение Umbra."
              : "Вход для приложения Umbra: после входа браузер сам вернёт вас в приложение."}
          </p>
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
