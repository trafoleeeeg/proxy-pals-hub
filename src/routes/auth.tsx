import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { signInPrimaryAccount } from "@/lib/app-supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Search = {
  next?: string | undefined;
};

export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    next: typeof s["next"] === "string" ? s["next"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Вход в Umbra" },
      { name: "description", content: "Вход в систему управления профилями Umbra." },
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

// Короткий логин без «@» превращаем в служебный адрес Umbra.
function toEmail(login: string) {
  const value = login.trim();
  return value.includes("@") ? value : `${value.toLowerCase()}@umbra.app`;
}

function AuthPage() {
  const search = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const next = safeNext(search.next);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await signInPrimaryAccount(toEmail(email), password);
      // Recreate the auth client and all identity-dependent caches together.
      window.location.replace(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось выполнить вход");
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
          Вход
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Войдите, чтобы управлять профилями и командой.
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Логин или почта</Label>
            <Input
              id="email"
              type="text"
              required
              autoComplete="username"
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
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            Войти
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Публичная регистрация временно закрыта. Учётную запись и доступы выдаёт владелец Umbra.
        </p>
      </div>
    </div>
  );
}
