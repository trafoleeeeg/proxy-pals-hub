import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createContext, createElement, useContext, useState, type ReactNode } from "react";
import { listWorkspaces, type Workspace } from "./team.functions";
import { workspaceQueryOptions } from "./panel-query-recovery";

const Selection = createContext<{ teamId: string | undefined; select: (teamId: string) => void }>({ teamId: undefined, select: () => {} });

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [teamId, select] = useState<string>();
  return createElement(Selection.Provider, { value: { teamId, select } }, children);
}

export function useWorkspaceSelection() {
  const selection = useContext(Selection);
  const fn = useServerFn(listWorkspaces);
  const workspaces = useQuery(workspaceQueryOptions(() => fn({}), selection.teamId));
  return { ...selection, workspaces };
}

export function useWorkspace() {
  const fn = useServerFn(listWorkspaces);
  const { teamId } = useContext(Selection);
  return useQuery({
    // Shares one server-verified request with the workspace selector. Selection
    // is not a new authorization grant: every operation still passes server RLS.
    ...workspaceQueryOptions(() => fn({}), teamId),
    select: (workspaces: Workspace[]) => {
      const workspace = teamId ? workspaces.find(item => item.teamId === teamId) : workspaces[0];
      if (!workspace) throw new Error("Команда недоступна");
      return workspace;
    },
  });
}
