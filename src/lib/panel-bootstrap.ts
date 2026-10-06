import type { QueryClient } from "@tanstack/react-query";
import { getAuthenticatedUser, getUsableSession, withAuthTimeout } from "./auth-session";
import { listWorkspaces } from "./team.functions";

export async function getPanelUser(queryClient: QueryClient) {
  const session = await getUsableSession();
  if (!session) return null;
  // Start independent server work together instead of user -> teams -> teams
  // again. Never use the stored user as proof or seed private query caches early.
  const workspacesJob = withAuthTimeout(listWorkspaces({})).catch(() => undefined);
  const user = await getAuthenticatedUser();
  if (!user) return null;
  const workspaces = await workspacesJob;
  const current = await getUsableSession();
  if (!current || current.user.id !== user.id || session.user.id !== user.id) throw new Error("Сессия изменилась. Войдите снова.");
  if (workspaces) {
    if (workspaces.some(workspace => workspace.userId !== user.id)) throw new Error("Сервер вернул другую учётную запись.");
    queryClient.setQueryData(["workspaces"], workspaces);
  }
  return user;
}
