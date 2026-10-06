import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { QueryClient } from "@tanstack/react-query";

const source = fileURLToPath(new URL("../src/lib/panel-bootstrap.ts", import.meta.url));
const modules: Record<string, string> = {
  entry: `export * from ${JSON.stringify(source)}; export * from 'panel-test:state';`,
  state: `export const state = { storedId: 'member', userId: 'member', teamId: 'member', session: true, reads: 0, workspaces: 0, delay: null, verifying: null, failTeams: false, failAuth: false };`,
  auth: `import { state } from 'panel-test:state';
    export const getUsableSession = async () => { state.reads++; return state.session ? { user: { id: state.storedId } } : null; };
    export const getAuthenticatedUser = async () => { if (state.verifying) await state.verifying; if (state.failAuth) throw new Error('offline'); return state.userId ? { id: state.userId } : null; };
    export const withAuthTimeout = x => x;`,
  teams: `import { state } from 'panel-test:state'; export const listWorkspaces = async () => { state.workspaces++; if (state.delay) await state.delay; if (state.failTeams) throw new Error('offline'); return [{ userId: state.teamId, teamId: 'allowed-team', role: 'member' }]; };`,
};
const build = await Bun.build({ entrypoints: ["panel-test:entry"], target: "bun", write: false,
  plugins: [{ name: "isolated-panel-bootstrap", setup(build) {
    build.onResolve({ filter: /^panel-test:/ }, ({ path }) => ({ path: path.slice(11), namespace: "panel-test" }));
    build.onResolve({ filter: /^\.\/auth-session$/ }, () => ({ path: "auth", namespace: "panel-test" }));
    build.onResolve({ filter: /^\.\/team.functions$/ }, () => ({ path: "teams", namespace: "panel-test" }));
    build.onLoad({ filter: /.*/, namespace: "panel-test" }, ({ path }) => ({ contents: modules[path]!, loader: "ts", resolveDir: fileURLToPath(new URL("..", import.meta.url)) }));
  } }],
});
if (!build.success) throw new AggregateError(build.logs);
const fixturePath = join(mkdtempSync(join(tmpdir(), "umbra-panel-bootstrap-")), "fixture.js");
writeFileSync(fixturePath, await build.outputs[0]!.text());
const api = await import(pathToFileURL(fixturePath).href);
afterEach(() => Object.assign(api.state, { storedId: "member", userId: "member", teamId: "member", session: true, reads: 0, workspaces: 0, delay: null, verifying: null, failTeams: false, failAuth: false }));

test("starts server workspace request during verification but caches nothing until accepted", async () => {
  let verify!: () => void;
  api.state.verifying = new Promise<void>(resolve => { verify = resolve; });
  const query = new QueryClient(); const pending = api.getPanelUser(query);
  await Promise.resolve(); await Promise.resolve();
  expect(api.state.workspaces).toBe(1);
  expect(query.getQueryData(["workspaces"])).toBeUndefined();
  verify(); expect((await pending).id).toBe("member");
  expect((query.getQueryData(["workspaces"]) as any[])[0].role).toBe("member");
});

test("a cold unsigned session cannot load private data", async () => {
  api.state.session = false;
  expect(await api.getPanelUser(new QueryClient())).toBeNull();
  expect(api.state.workspaces).toBe(0);
});

test.each([null, "other-user"])("rejected/different verified identity (%s) cannot seed account data", async userId => {
  api.state.userId = userId;
  const query = new QueryClient();
  if (userId === null) expect(await api.getPanelUser(query)).toBeNull();
  else await expect(api.getPanelUser(query)).rejects.toThrow("Сессия изменилась");
  expect(query.getQueryData(["workspaces"])).toBeUndefined();
});

test("workspace results for another identity are rejected, never promoted to owner", async () => {
  api.state.teamId = "owner";
  const query = new QueryClient();
  await expect(api.getPanelUser(query)).rejects.toThrow("другую учётную запись");
  expect(query.getQueryData(["workspaces"])).toBeUndefined();
});

test("a workspace network failure does not invalidate independently verified auth", async () => {
  api.state.failTeams = true;
  const query = new QueryClient();
  expect((await api.getPanelUser(query)).id).toBe("member");
  expect(query.getQueryData(["workspaces"])).toBeUndefined();
  api.state.failAuth = true;
  await expect(api.getPanelUser(query)).rejects.toThrow("offline");
});
