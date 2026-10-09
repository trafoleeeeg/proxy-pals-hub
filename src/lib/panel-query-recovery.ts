import type { QueryClient } from "@tanstack/react-query";
import { ConnectionUnavailableError } from "./panel-connectivity";

// Chromium can miss the online event after sleep. Panel reads have bounded
// auth/RPC transports, so let the request determine connectivity. This applies
// to queries without changing the browser's online flag or resuming mutations.
export const PANEL_QUERY_DEFAULTS = {
  staleTime: 15_000,
  networkMode: "always" as const,
  retry: false as const,
  refetchOnReconnect: true,
};

// A new explicit action must also work after a missed online event. Execute it
// once through the bounded transport; never queue/replay a failed write later.
// Existing paused mutations keep their options and are not resumed by recovery.
export const PANEL_MUTATION_DEFAULTS = {
  networkMode: "always" as const,
  retry: false as const,
};

export function panelAuthQueryOptions<T>(verify: () => Promise<T>) {
  return {
    ...PANEL_QUERY_DEFAULTS,
    queryKey: ["authenticated-user"],
    queryFn: verify,
    staleTime: 30_000,
    gcTime: Infinity,
  };
}

export function workspaceQueryOptions<T extends { teamId: string }[]>(read: () => Promise<T>, selectedTeamId?: string) {
  return {
    ...PANEL_QUERY_DEFAULTS,
    queryKey: ["workspaces"],
    queryFn: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ConnectionUnavailableError("Сервер не ответил вовремя")), 8_000);
      });
      try {
        const workspaces = await Promise.race([read(), timeout]);
        if (!workspaces.length || (selectedTeamId && !workspaces.some((workspace) => workspace.teamId === selectedTeamId))) {
          throw new Error("Команда недоступна");
        }
        return workspaces;
      }
      finally { if (timer) clearTimeout(timer); }
    },
    staleTime: 60_000,
  };
}

export function refreshPanelWorkspace<T extends { teamId: string }[]>(queryClient: QueryClient, read: () => Promise<T>) {
  const fallback = workspaceQueryOptions(read);
  const current = queryClient.getQueryCache().find({ queryKey: fallback.queryKey, exact: true });
  // Mounted workspace readers also validate the user's current team selection.
  // Keep that reader instead of silently falling back to another available team.
  return queryClient.fetchQuery<unknown, Error, unknown, string[]>({ ...fallback, queryFn: current?.options.queryFn ?? fallback.queryFn, staleTime: 0 });
}

export async function recoverPanelQueries({ queryClient, signal, reloadRoutes, refreshWorkspace }: {
  queryClient: QueryClient;
  signal: AbortSignal;
  reloadRoutes: () => Promise<unknown>;
  refreshWorkspace: () => Promise<unknown>;
}) {
  const predicate = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== "authenticated-user";
  const cancel = () => { void queryClient.cancelQueries({ predicate }); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    await queryClient.cancelQueries({ predicate });
    signal.throwIfAborted();
    await reloadRoutes();
    signal.throwIfAborted();
    // invalidateQueries can resolve without fetching a paused/inactive query.
    // Await an actual workspace read before reporting successful recovery.
    await refreshWorkspace();
    signal.throwIfAborted();
    await queryClient.invalidateQueries({ predicate: (query) => predicate(query) && query.queryKey[0] !== "workspaces" }, { throwOnError: true });
    signal.throwIfAborted();
  } finally { signal.removeEventListener("abort", cancel); }
}
