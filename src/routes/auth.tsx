import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Search = { mode?: string | undefined; next?: string | undefined };

export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    mode: typeof s["mode"] === "string" ? s["mode"] : undefined,
    next: typeof s["next"] === "string" ? s["next"] : undefined,
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

  const next = safeNext(search.next);

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
    setBusy(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: `${window.location.origin}/auth?next=${encodeURIComponent(next)}`,
      });
      if (result.error) {
        toast.error("Не удалось войти через Google");
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
