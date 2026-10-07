import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createContext, createElement, useContext, useState, type ReactNode } from "react";
import { listWorkspaces, type Workspace } from "./team.functions";
import { ConnectionUnavailableError } from "./panel-connectivity";

const Selection = createContext<{ teamId: string | undefined; select: (teamId: string) => void }>({ teamId: undefined, select: () => {} });
const WORKSPACE_TIMEOUT_MS = 8_000;

async function withWorkspaceTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ConnectionUnavailableError("Сервер не ответил вовремя")), WORKSPACE_TIMEOUT_MS);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [teamId, select] = useState<string>();
  return createElement(Selection.Provider, { value: { teamId, select } }, children);
}

export function useWorkspaceSelection() {
  const selection = useContext(Selection);
  const fn = useServerFn(listWorkspaces);
  const workspaces = useQuery({
    queryKey: ["workspaces"], queryFn: () => withWorkspaceTimeout(fn({})), staleTime: 60_000,
    // Emergency recovery mode: never hold the whole panel through several
    // serial retries. The visible retry button starts a fresh request.
    retry: false, refetchOnReconnect: true,
  });
  return { ...selection, workspaces };
}

export function useWorkspace() {
  const fn = useServerFn(listWorkspaces);
  const { teamId } = useContext(Selection);
  return useQuery({
    // Shares one server-verified request with the workspace selector. Selection
    // is not a new authorization grant: every operation still passes server RLS.
    queryKey: ["workspaces"],
    queryFn: () => withWorkspaceTimeout(fn({})),
    select: (workspaces: Workspace[]) => {
      const workspace = teamId ? workspaces.find(item => item.teamId === teamId) : workspaces[0];
      if (!workspace) throw new Error("Команда недоступна");
      return workspace;
    },
    staleTime: 60_000,
    retry: false,
    refetchOnReconnect: true,
  });
}
