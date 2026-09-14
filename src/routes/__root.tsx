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
import { supabase } from "@/integrations/supabase/client";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import "@/lib/desktop";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
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
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
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
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap",
      },
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

function AuthSync() {
  const router = useRouter();

  function safeDesktopCallback(value: string | null) {
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

  function handSessionToDesktop(session: { access_token: string; refresh_token: string } | null) {
    if (!session || typeof window === "undefined" || window.umbra) return false;
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem("umbra:desktop-callback");
    } catch {
      return false;
    }
    const callback = safeDesktopCallback(saved);
    if (!callback) return false;
    callback.searchParams.set("access_token", session.access_token);
    callback.searchParams.set("refresh_token", session.refresh_token);
    sessionStorage.removeItem("umbra:desktop-callback");
    window.location.replace(callback.toString());
    return true;
  }

  // Настольное приложение: токены, полученные из системного браузера.
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.umbra : null;
    if (!bridge) return;
    const unsubscribe = bridge.onAuthTokens(async (tokens) => {
      const { error } = await supabase.auth.setSession(tokens);
      if (error) {
        toast.error("Не удалось перенести вход из браузера");
        return;
      }
      toast.success("Вход выполнен");
      window.location.replace("/app");
    });
    bridge.notifyReady();
    return unsubscribe;
  }, []);

  // Системный браузер: сохраняем локальный callback до OAuth, потому что Google
  // может вернуть только на origin без исходных query-параметров.
  useEffect(() => {
    if (typeof window === "undefined" || window.umbra) return;
    const params = new URLSearchParams(window.location.search);
    const callback = safeDesktopCallback(params.get("cb"));
    if (params.get("desktop") === "1" && callback) {
      try {
        sessionStorage.setItem("umbra:desktop-callback", callback.toString());
      } catch {
        return;
      }
    }
    void supabase.auth.getSession().then(({ data }) => handSessionToDesktop(data.session));
  }, []);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED") return;
      if (event === "SIGNED_IN" && handSessionToDesktop(session)) return;
      // Браузер, открытый настольным приложением: сессию отдаёт страница /auth.
      if (window.location.search.includes("desktop=1")) return;
      router.invalidate();
      if (event === "SIGNED_IN") {
        let next = "/app";
        try {
          next = sessionStorage.getItem("umbra:next") || "/app";
          sessionStorage.removeItem("umbra:next");
        } catch {
          /* ignore */
        }
        const here = window.location.pathname;
        if (here === "/" || here === "/auth") {
          window.location.replace(next.startsWith("/") ? next : "/app");
        }
      }
    });
    return () => data.subscription.unsubscribe();
  }, [router]);
  return null;
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthSync />
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      <Toaster position="top-right" richColors />
    </QueryClientProvider>
  );
}
