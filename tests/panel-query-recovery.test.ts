import { afterEach, expect, test } from "bun:test";
import { MutationObserver, onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { ConnectionUnavailableError, connectionUnavailable, setConnectionUnavailable } from "../src/lib/panel-connectivity";
import { assertPanelRoutesReady, createPanelRecovery } from "../src/lib/panel-recovery";
import { PANEL_MUTATION_DEFAULTS, PANEL_QUERY_DEFAULTS, panelAuthQueryOptions, recoverPanelQueries, refreshPanelWorkspace, workspaceQueryOptions } from "../src/lib/panel-query-recovery";

afterEach(() => { onlineManager.setOnline(true); setConnectionUnavailable(false); });

test("lost online event cannot pause route, workspace, or active panel reads; mutations stay paused", async () => {
  const client = new QueryClient({ defaultOptions: { queries: PANEL_QUERY_DEFAULTS } });
  client.mount();
  let serverAvailable = true, authReads = 0, workspaceReads = 0, profileReads = 0, folderReads = 0, writes = 0;
  const verify = async () => {
    authReads++;
    if (!serverAvailable) throw new ConnectionUnavailableError();
    return { id: "synthetic-user" };
  };
  const readWorkspace = async () => {
    workspaceReads++;
    if (!serverAvailable) throw new ConnectionUnavailableError();
    return [{ teamId: "synthetic-team" }];
  };
  const root = createRootRoute();
  const app = createRoute({ getParentRoute: () => root, path: "/app", beforeLoad: () => client.fetchQuery(panelAuthQueryOptions(verify)) });
  const router = createRouter({ routeTree: root.addChildren([app]), history: createMemoryHistory({ initialEntries: ["/app"] }) });
  const workspace = new QueryObserver(client, workspaceQueryOptions(readWorkspace));
  const profiles = new QueryObserver(client, { queryKey: ["profiles", "synthetic-team"], queryFn: async () => {
    profileReads++; if (!serverAvailable) throw new ConnectionUnavailableError(); return ["synthetic-profile"];
  } });
  const folders = new QueryObserver(client, { queryKey: ["folders", "synthetic-team"], queryFn: async () => {
    folderReads++; if (!serverAvailable) throw new ConnectionUnavailableError(); return ["synthetic-folder"];
  } });
  const unsubscribe = [workspace, profiles, folders].map((observer) => observer.subscribe(() => {}));
  const recovery = createPanelRecovery({
    timeoutMs: 500,
    verify,
    expired: () => { throw new Error("valid synthetic auth must not sign out"); },
    recovered: (signal) => recoverPanelQueries({
      queryClient: client, signal,
      reloadRoutes: async () => { await router.invalidate({ sync: true }); assertPanelRoutesReady(router.state.matches); },
      refreshWorkspace: () => refreshPanelWorkspace(client, readWorkspace),
    }),
  });
  try {
    await router.load();
    await client.refetchQueries();
    onlineManager.setOnline(false);
    serverAvailable = false;
    await client.invalidateQueries();
    expect((await recovery.run()).status).toBe("offline");
    expect(connectionUnavailable()).toBe(true);
    const failedCounts = { authReads, workspaceReads, profileReads, folderReads };
    const mutation = new MutationObserver(client, { mutationFn: async () => { writes++; } });
    void mutation.mutate();
    await Promise.resolve();
    expect(mutation.getCurrentResult().isPaused).toBe(true);

    // Only the actual server recovers; Chromium never dispatches online.
    serverAvailable = true;
    expect((await recovery.run()).status).toBe("recovered");
    expect(connectionUnavailable()).toBe(false);
    expect(onlineManager.isOnline()).toBe(false);
    expect(authReads).toBeGreaterThan(failedCounts.authReads);
    expect(workspaceReads).toBeGreaterThan(failedCounts.workspaceReads);
    expect(profileReads).toBeGreaterThan(failedCounts.profileReads);
    expect(folderReads).toBeGreaterThan(failedCounts.folderReads);
    for (const query of client.getQueryCache().getAll()) {
      expect(query.state.status).toBe("success");
      expect(query.state.fetchStatus).toBe("idle");
    }
    expect(mutation.getCurrentResult().isPaused).toBe(true);
    expect(writes).toBe(0);
  } finally {
    recovery.dispose();
    unsubscribe.forEach((off) => off());
    client.unmount();
    client.clear();
  }
});

test("successful route auth cannot hide a failed inactive workspace read", async () => {
  const client = new QueryClient({ defaultOptions: { queries: PANEL_QUERY_DEFAULTS } });
  client.setQueryData(["workspaces"], [{ teamId: "cached-team" }]);
  let serverAvailable = false, reads = 0;
  const recovery = createPanelRecovery({
    verify: async () => ({ id: "synthetic-user" }), expired: () => {},
    recovered: (signal) => recoverPanelQueries({
      queryClient: client, signal, reloadRoutes: async () => {},
      refreshWorkspace: () => refreshPanelWorkspace(client, async () => {
        reads++;
        if (!serverAvailable) throw new ConnectionUnavailableError();
        return [{ teamId: "fresh-team" }];
      }),
    }),
  });
  try {
    onlineManager.setOnline(false);
    setConnectionUnavailable(true);
    expect((await recovery.run()).status).toBe("offline");
    expect(connectionUnavailable()).toBe(true);
    expect(reads).toBe(1);
    serverAvailable = true;
    expect((await recovery.run()).status).toBe("recovered");
    expect(reads).toBe(2);
    expect(client.getQueryData(["workspaces"])).toEqual([{ teamId: "fresh-team" }]);
    expect(onlineManager.isOnline()).toBe(false);
  } finally { recovery.dispose(); client.clear(); }
});

test("an offline read fails once without an internal retry queue", async () => {
  const client = new QueryClient({ defaultOptions: { queries: PANEL_QUERY_DEFAULTS } });
  let reads = 0;
  const observer = new QueryObserver(client, { queryKey: ["profiles"], queryFn: async () => { reads++; throw new ConnectionUnavailableError(); } });
  onlineManager.setOnline(false);
  const off = observer.subscribe(() => {});
  try {
    await expect(observer.refetch({ throwOnError: true })).rejects.toBeInstanceOf(ConnectionUnavailableError);
    expect(reads).toBe(1);
    expect(observer.getCurrentResult().fetchStatus).toBe("idle");
    expect(observer.getCurrentResult().isError).toBe(true);
  } finally { off(); client.clear(); }
});

test("new explicit mutations run once with a stale offline flag and never resume an older paused write", async () => {
  const client = new QueryClient({ defaultOptions: { queries: PANEL_QUERY_DEFAULTS } });
  client.mount();
  onlineManager.setOnline(false);
  let oldWrites = 0, newWrites = 0, failedWrites = 0;
  const cache = client.getMutationCache();
  const oldWrite = cache.build(client, { mutationFn: async () => { oldWrites++; } });
  void oldWrite.execute(undefined);
  await Promise.resolve();
  expect(oldWrite.state.isPaused).toBe(true);
  // Model an already existing paused write; changing defaults must not change
  // its captured options or act like onlineManager/resumePausedMutations.
  client.setDefaultOptions({ queries: PANEL_QUERY_DEFAULTS, mutations: PANEL_MUTATION_DEFAULTS });
  const recovery = createPanelRecovery({
    verify: async () => ({ id: "synthetic-user" }), expired: () => {},
    recovered: (signal) => recoverPanelQueries({ queryClient: client, signal, reloadRoutes: async () => {},
      refreshWorkspace: () => refreshPanelWorkspace(client, async () => [{ teamId: "synthetic-team" }]),
    }),
  });
  try {
    setConnectionUnavailable(true);
    expect((await recovery.run()).status).toBe("recovered");
    const freshWrite = cache.build(client, { mutationFn: async () => { newWrites++; return "saved"; } });
    expect(await freshWrite.execute(undefined)).toBe("saved");
    expect(freshWrite.state.status).toBe("success");
    expect(newWrites).toBe(1);
    const failedWrite = cache.build(client, { mutationFn: async () => { failedWrites++; throw new ConnectionUnavailableError(); } });
    await expect(failedWrite.execute(undefined)).rejects.toBeInstanceOf(ConnectionUnavailableError);
    expect(failedWrite.state.status).toBe("error");
    expect(failedWrite.state.isPaused).toBe(false);
    expect((await recovery.run()).status).toBe("recovered");
    expect(failedWrites).toBe(1);
    expect(oldWrites).toBe(0);
    expect(oldWrite.state.isPaused).toBe(true);
    expect(onlineManager.isOnline()).toBe(false);
  } finally { recovery.dispose(); client.unmount(); client.clear(); }
});

test.each(["empty", "selected-team-revoked"])("%s workspace is an application failure, not successful recovery or an offline loop", async (failure) => {
  const client = new QueryClient({ defaultOptions: { queries: PANEL_QUERY_DEFAULTS } });
  let workspaces = [{ teamId: "selected-team" }], reads = 0, fallbackReads = 0;
  const read = async () => { reads++; return workspaces; };
  const selected = failure === "selected-team-revoked" ? "selected-team" : undefined;
  const observer = new QueryObserver(client, workspaceQueryOptions(read, selected));
  const off = observer.subscribe(() => {});
  const recovery = createPanelRecovery({
    verify: async () => ({ id: "synthetic-user" }), expired: () => {},
    recovered: (signal) => recoverPanelQueries({ queryClient: client, signal, reloadRoutes: async () => {},
      refreshWorkspace: () => refreshPanelWorkspace(client, async () => { fallbackReads++; return [{ teamId: "different-team" }]; }),
    }),
  });
  try {
    await observer.refetch({ throwOnError: true });
    workspaces = failure === "empty" ? [] : [{ teamId: "different-team" }];
    onlineManager.setOnline(false);
    setConnectionUnavailable(true);
    const result = await recovery.run();
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect((result.error as Error).message).toBe("Команда недоступна");
    expect(connectionUnavailable()).toBe(false);
    expect(recovery.needsRecovery()).toBe(false);
    expect(fallbackReads).toBe(0);
    const failedReads = reads;
    expect((await recovery.run()).status).toBe("skipped");
    expect(reads).toBe(failedReads);
    workspaces = [{ teamId: "selected-team" }];
    expect((await recovery.run({ retry: true })).status).toBe("recovered");
    expect(onlineManager.isOnline()).toBe(false);
  } finally { recovery.dispose(); off(); client.clear(); }
});
