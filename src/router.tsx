import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { PanelPending } from "./components/panel-pending";
import { PANEL_MUTATION_DEFAULTS, PANEL_QUERY_DEFAULTS } from "./lib/panel-query-recovery";

export const getRouter = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: PANEL_QUERY_DEFAULTS, mutations: PANEL_MUTATION_DEFAULTS } });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PanelPending,
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });

  return router;
};
