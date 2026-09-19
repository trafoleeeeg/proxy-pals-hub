import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyPermissions } from "./team.functions";

export const PERMISSION_LABELS = {
  "profile.create": "Создавать профили",
  "profile.edit": "Изменять профили",
  "profile.delete": "Удалять профили",
  "profile.proxy": "Менять прокси у профиля",
  "folder.manage": "Создавать и удалять папки",
  "proxy.manage": "Управлять прокси команды",
  "bookmarks.manage": "Управлять закладками команды",
} as const;

export type PermissionKey = keyof typeof PERMISSION_LABELS;
export const PERMISSION_ORDER = Object.keys(PERMISSION_LABELS) as PermissionKey[];
export const EMPTY_PERMISSIONS = Object.fromEntries(PERMISSION_ORDER.map((key) => [key, false])) as Record<PermissionKey, boolean>;

export function usePermissions(teamId: string | undefined) {
  const fetchPermissions = useServerFn(getMyPermissions);
  const query = useQuery({
    queryKey: ["permissions", teamId],
    queryFn: () => fetchPermissions({ data: { teamId: teamId! } }),
    enabled: !!teamId,
    staleTime: 60_000,
  });
  const can = (key: PermissionKey) => query.data?.[key] === true;
  return { can, scope: query.data?.scope ?? null, isPending: query.isPending, permissions: query.data };
}
