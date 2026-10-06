import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { isPrimarySignInPending, supabase } from "@/lib/app-supabase";
import { Toaster } from "@/components/ui/sonner";
import { PanelConnection } from "@/components/panel-connection";
import { PanelPainted } from "@/components/panel-painted";
import { isConnectionUnavailable } from "@/lib/panel-connectivity";
import "@/lib/desktop";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <PanelPainted />
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    if (!isConnectionUnavailable(error)) reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <PanelPainted />
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {isConnectionUnavailable(error) ? "Восстанавливаем подключение" : "Не удалось загрузить панель"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Панель можно перезагрузить отдельно от приложения. Открытые окна профилей не закрываются.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {isConnectionUnavailable(error) && <PanelConnection fullPage recovered={async () => { await router.invalidate(); reset(); }} />}
          <button
            onClick={() => {
              const url = new URL(window.location.href);
              url.searchParams.set("panel-recovery", String(Date.now()));
              window.location.replace(url.href);
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Перезагрузить панель
          </button>
          <a
            href="/app"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            На главную
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Umbra — мультиаккаунтинг под своим контролем" },
      {
        name: "description",
        content:
          "Собственная система антидетект-профилей: отпечатки, прокси и командный доступ без абонентской платы.",
      },
      { property: "og:title", content: "Umbra — мультиаккаунтинг под своим контролем" },
      {
        property: "og:description",
        content: "Профили, отпечатки, прокси и доступы команды в одном защищённом месте.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function AuthSync({ queryClient }: { queryClient: QueryClient }) {
  const router = useRouter();

  useEffect(() => {
    let previousUserId: string | null | undefined;
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      const userId = session?.user.id ?? null;
      if (previousUserId !== undefined && previousUserId !== userId) queryClient.clear();
      previousUserId = userId;
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      if (event === "SIGNED_OUT") queryClient.clear();
      if (isPrimarySignInPending()) return;
      // Auth callbacks execute while the auth client can still own its Web Lock.
      // Defer router work so protected requests never wait on that same lock.
      window.setTimeout(() => {
        if (isPrimarySignInPending() || previousUserId !== userId) return;
        void router.invalidate();
        // SIGNED_IN also fires when an old stored session is refreshed. Do not
        // eject the operator from the login form before explicit login finishes.
        if (event === "SIGNED_OUT" && window.location.pathname !== "/auth") {
          const next = window.location.pathname.startsWith("/") ? window.location.pathname : "/app";
          window.location.replace(`/auth?next=${encodeURIComponent(next)}`);
        }
      }, 0);
    });
    return () => data.subscription.unsubscribe();
  }, [queryClient, router]);
  return null;
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  return (
    <QueryClientProvider client={queryClient}>
      <PanelPainted />
      <AuthSync queryClient={queryClient} />
      <PanelConnection recovered={async () => {
        await router.invalidate();
        await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "authenticated-user" });
      }} />
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      <Toaster position="top-right" richColors />
    </QueryClientProvider>
  );
}
