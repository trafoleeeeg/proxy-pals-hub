import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { acceptInvite } from "@/lib/team.functions";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/invite/$token")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Приглашение в команду — Umbra" },
      { name: "description", content: "Принять приглашение в рабочую команду Umbra." },
      { property: "og:title", content: "Приглашение в команду — Umbra" },
      { property: "og:description", content: "Принять приглашение в рабочую команду Umbra." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: InvitePage,
});

function InvitePage() {
  const { token } = Route.useParams();
  const accept = useServerFn(acceptInvite);
  const navigate = useNavigate();
  const [state, setState] = useState<"checking" | "anon" | "working" | "error">("checking");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!data.user) {
        setState("anon");
        return;
      }
      setState("working");
      try {
        await accept({ data: { token } });
        navigate({ to: "/app" });
      } catch (e) {
        setState("error");
        setMessage(e instanceof Error ? e.message : "Не удалось принять приглашение");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, accept, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center grid-bg px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 text-center">
        <h1 className="text-xl font-semibold">Приглашение в команду</h1>
        {state === "checking" && (
          <p className="mt-3 text-sm text-muted-foreground">Проверяем приглашение…</p>
        )}
        {state === "working" && (
          <p className="mt-3 text-sm text-muted-foreground">Добавляем вас в команду…</p>
        )}
        {state === "anon" && (
          <>
            <p className="mt-3 text-sm text-muted-foreground">
              Войдите или зарегистрируйтесь той же почтой, на которую пришло приглашение.
            </p>
            <Button asChild className="mt-5 w-full">
              <Link to="/auth" search={{ next: `/invite/${token}` }}>
                Продолжить
              </Link>
            </Button>
          </>
        )}
        {state === "error" && <p className="mt-3 text-sm text-destructive">{message}</p>}
      </div>
    </div>
  );
}
