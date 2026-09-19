import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createContext, createElement, useContext, useState, type ReactNode } from "react";
import { getWorkspace, listWorkspaces } from "./team.functions";

const Selection = createContext<{ teamId: string | undefined; select: (teamId: string) => void }>({ teamId: undefined, select: () => {} });
const WORKSPACE_TIMEOUT_MS = 15_000;

async function withWorkspaceTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Сервер не ответил вовремя")), WORKSPACE_TIMEOUT_MS);
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
    retry: 2, retryDelay: 1_000, refetchOnReconnect: true,
  });
  return { ...selection, workspaces };
}

export function useWorkspace() {
  const fn = useServerFn(getWorkspace);
  const { teamId } = useContext(Selection);
  return useQuery({
    queryKey: ["workspace", teamId],
    queryFn: () => withWorkspaceTimeout(fn({ data: teamId ? { teamId } : {} })),
    staleTime: 60_000,
    retry: 2,
    retryDelay: 1_000,
    refetchOnReconnect: true,
  });
}
