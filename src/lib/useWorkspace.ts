import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createContext, createElement, useContext, useState, type ReactNode } from "react";
import { getWorkspace, listWorkspaces } from "./team.functions";

const Selection = createContext<{ teamId: string | undefined; select: (teamId: string) => void }>({ teamId: undefined, select: () => {} });

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [teamId, select] = useState<string>();
  return createElement(Selection.Provider, { value: { teamId, select } }, children);
}

export function useWorkspaceSelection() {
  const selection = useContext(Selection);
  const fn = useServerFn(listWorkspaces);
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => fn({}), staleTime: 60_000 });
  return { ...selection, workspaces };
}

export function useWorkspace() {
  const fn = useServerFn(getWorkspace);
  const { teamId } = useContext(Selection);
  return useQuery({
    queryKey: ["workspace", teamId],
    queryFn: () => fn({ data: teamId ? { teamId } : {} }),
    staleTime: 60_000,
  });
}
