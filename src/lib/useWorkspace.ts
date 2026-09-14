import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getWorkspace } from "./team.functions";

export function useWorkspace() {
  const fn = useServerFn(getWorkspace);
  return useQuery({
    queryKey: ["workspace"],
    queryFn: () => fn({}),
    staleTime: 60_000,
  });
}
