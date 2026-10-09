import { fixture } from "./mock-api";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AppLayout } from "../../src/routes/_authenticated/app";
import { ProfilesPage } from "../../src/routes/_authenticated/app.index";
import { TeamPage } from "../../src/routes/_authenticated/app.team";
import { ClientPage } from "../../src/routes/_authenticated/app.desktop";
import { ProxiesPage } from "../../src/routes/_authenticated/app.proxies";
import { FoldersPage } from "../../src/routes/_authenticated/app.folders";
import { TrashPage } from "../../src/routes/_authenticated/app.trash";
import { AuditPage } from "../../src/routes/_authenticated/app.audit";
import { Route as AgentsRoute } from "../../src/routes/_authenticated/app.agents";
import "../../src/styles.css";
import { PanelConnection } from "../../src/components/panel-connection";
import { PANEL_MUTATION_DEFAULTS, PANEL_QUERY_DEFAULTS, panelAuthQueryOptions, recoverPanelQueries, refreshPanelWorkspace } from "../../src/lib/panel-query-recovery";
import { assertPanelRoutesReady } from "../../src/lib/panel-recovery";
import { getAuthenticatedUser } from "../../src/lib/auth-session";
import { setConnectionUnavailable } from "../../src/lib/panel-connectivity";
import { listWorkspaces } from "./mock-api";

const client = new QueryClient({ defaultOptions: { queries: PANEL_QUERY_DEFAULTS, mutations: PANEL_MUTATION_DEFAULTS } });
if (new URLSearchParams(location.search).get("scenario") === "lost-online") {
  onlineManager.setOnline(false);
  setConnectionUnavailable(true);
}

const root = createRootRoute();
const app = createRoute({ getParentRoute: () => root, path: "app", component: AppLayout,
  beforeLoad: () => client.fetchQuery(panelAuthQueryOptions(getAuthenticatedUser)),
});
const profiles = createRoute({ getParentRoute: () => app, path: "/", component: ProfilesPage });
const team = createRoute({ getParentRoute: () => app, path: "team", component: TeamPage });
const desktop = createRoute({ getParentRoute: () => app, path: "desktop", component: ClientPage });
const proxies = createRoute({ getParentRoute: () => app, path: "proxies", component: ProxiesPage });
const folders = createRoute({ getParentRoute: () => app, path: "folders", component: FoldersPage });
const trash = createRoute({ getParentRoute: () => app, path: "trash", component: TrashPage });
const audit = createRoute({ getParentRoute: () => app, path: "audit", component: AuditPage });
const agents = createRoute({ getParentRoute: () => app, path: "agents", component: AgentsRoute.options.component! });
const auth = createRoute({ getParentRoute: () => root, path: "auth", component: () => <p>Выход выполнен</p> });
const router = createRouter({ routeTree: root.addChildren([app.addChildren([profiles, team, desktop, proxies, folders, trash, audit, agents]), auth]) });
fixture.refreshWorkspaces = async () => { await client.invalidateQueries({ queryKey: ["workspaces"] }); };
createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={client}><PanelConnection recovered={(signal) => recoverPanelQueries({
  queryClient: client, signal,
  reloadRoutes: async () => { await router.invalidate({ sync: true }); assertPanelRoutesReady(router.state.matches); },
  refreshWorkspace: async () => {
    if (router.state.location.pathname.startsWith("/app")) {
      await refreshPanelWorkspace(client, () => listWorkspaces({}));
    }
  },
})} /><RouterProvider router={router} /><Toaster /></QueryClientProvider></StrictMode>);
