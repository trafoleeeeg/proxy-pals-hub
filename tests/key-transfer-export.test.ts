import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Actual component with tiny React/DOM/server-function fixtures. This exercises
// its event handlers and Blob contents, not a real browser or production API.
const component = fileURLToPath(new URL("../src/components/key-transfer-export.tsx", import.meta.url));
const modules: Record<string, string> = {
  entry: `export { KeyTransferExport } from ${JSON.stringify(component)}; export { model } from 'transfer-ui:state';`,
  state: `export const model = { values: [], cursor: 0, result: null, requestThrows: false, calls: [] };`,
  react: `import { model } from 'transfer-ui:state'; export function useState(initial) { const index=model.cursor++; if (!(index in model.values)) model.values[index]=initial; return [model.values[index], value=>{model.values[index]=value}]; }`,
  jsx: `export function jsx(type, props) { return {type,props}; } export const jsxs=jsx; export const jsxDEV=jsx; export const Fragment='fragment';`,
  start: `export const useServerFn=fn=>fn;`,
  workspace: `export const useWorkspace=()=>({data:{isSuperadmin:true}});`,
  button: `export const Button='button';`,
  icons: `export const Download='download'; export const ShieldCheck='shield-check';`,
  api: `import {model} from 'transfer-ui:state'; export async function getKeyTransferStatus() { return { enabled:true, sourceOrigin:'https://source.invalid',targetOrigin:'https://target.invalid',expiresAt:'synthetic',keyId:'public'}; }
    export async function exportEncryptedMigrationKey(input) { model.calls.push(input); if(model.requestThrows) throw new Error('SYNTHETIC_TRANSPORT_MUST_NOT_ESCAPE'); return model.result; }`,
};
const built = await Bun.build({ entrypoints: ["transfer-ui:entry"], target: "bun", write: false, plugins: [{ name: "isolated-key-transfer-ui", setup(build) {
  build.onResolve({ filter: /^transfer-ui:/ }, ({ path }) => ({ path: path.slice(12), namespace: "transfer-ui" }));
  for (const [filter, name] of [
    [/^react$/, "react"], [/^react\/jsx(?:-dev)?-runtime$/, "jsx"], [/^@tanstack\/react-start$/, "start"],
    [/^@\/lib\/useWorkspace$/, "workspace"], [/^@\/components\/ui\/button$/, "button"],
    [/^lucide-react$/, "icons"], [/^@\/lib\/key-transfer\.functions$/, "api"],
  ] as const) build.onResolve({ filter }, () => ({ path: name, namespace: "transfer-ui" }));
  build.onLoad({ filter: /.*/, namespace: "transfer-ui" }, ({ path }) => ({ contents: modules[path]!, loader: "ts", resolveDir: dirname(component) }));
} }] });
if (!built.success) throw new AggregateError(built.logs);
const fixtureDirectory = mkdtempSync(join(tmpdir(), "umbra-key-ui-"));
const fixture = join(fixtureDirectory, "fixture.js");
writeFileSync(fixture, await built.outputs[0]!.text());
const api = await import(pathToFileURL(fixture).href);
afterAll(() => {
  if (dirname(resolve(fixtureDirectory)) !== resolve(tmpdir()) || !basename(fixtureDirectory).startsWith("umbra-key-ui-")) throw new Error("Unexpected synthetic UI fixture path");
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

const originalDocument = (globalThis as any).document;
const originalCreateUrl = URL.createObjectURL;
const originalRevokeUrl = URL.revokeObjectURL;
const originalTimeout = globalThis.setTimeout;
let captured: Blob | null = null;
let clicked = false;
let revoked = false;
let clickThrows = false;
let filename = "";
const envelope = { format: "umbra-key-transfer-v1", transferId: "synthetic-id", ciphertext: "synthetic-ciphertext-only" };

function reset() {
  api.model.values = []; api.model.cursor = 0; api.model.result = { ok: true, envelope }; api.model.requestThrows = false; api.model.calls = [];
  captured = null; clicked = false; revoked = false; clickThrows = false; filename = "";
  (globalThis as any).document = { createElement(name: string) {
    if (name !== "a") throw new Error("Synthetic element mismatch");
    return { href: "", download: "", click() { if (clickThrows) throw new Error("SYNTHETIC_BROWSER_MUST_NOT_ESCAPE"); clicked = true; filename = this.download; } };
  } };
  URL.createObjectURL = value => { captured = value; return "blob:synthetic-envelope"; };
  URL.revokeObjectURL = value => { if (value === "blob:synthetic-envelope") revoked = true; };
  (globalThis as any).setTimeout = (callback: () => void) => { callback(); return 1; };
}
afterEach(() => {
  (globalThis as any).document = originalDocument;
  URL.createObjectURL = originalCreateUrl; URL.revokeObjectURL = originalRevokeUrl;
  globalThis.setTimeout = originalTimeout;
});
function render() { api.model.cursor = 0; return api.KeyTransferExport(); }
function flatten(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!node || typeof node !== "object") return [];
  return [node, ...flatten(node.props?.children)];
}
async function attempt() {
  const first = flatten(render()).find(node => node.type === "button");
  first.props.onClick(); await Bun.sleep(0);
  const download = flatten(render()).filter(node => node.type === "button").at(-1);
  download.props.onClick(); await Bun.sleep(0);
  return api.model.values[2] as string;
}

test("component downloads only the envelope, never the RPC union", async () => {
  reset();
  const message = await attempt();
  expect(api.model.calls).toEqual([{ data: {} }]);
  expect(clicked).toBe(true); expect(revoked).toBe(true);
  expect(filename).toBe("umbra-key-transfer-synthetic-id.json");
  expect(await captured!.text()).toBe(JSON.stringify(envelope));
  expect(message).toContain("Проверьте сохранение файла");
});

test.each(["source_key_unavailable", "crypto_import_failed", "canary_failed", "seal_failed"])("component displays finite %s without making a download", async code => {
  reset(); api.model.result = { ok: false, code };
  const message = await attempt();
  expect(message).toContain(code);
  expect(clicked).toBe(false); expect(captured).toBeNull();
});

test("browser download failure is separate and still revokes its Blob URL", async () => {
  reset(); clickThrows = true;
  const message = await attempt();
  expect(message).toContain("download_failed");
  expect(message).not.toContain("SYNTHETIC_BROWSER");
  expect(message).not.toContain("seal_failed");
  expect(revoked).toBe(true);
});

test("transport rejection stays generic and never exposes its exception", async () => {
  reset(); api.model.requestThrows = true;
  const message = await attempt();
  expect(message).toContain("Контейнер не получен");
  expect(message).not.toContain("SYNTHETIC_TRANSPORT");
  expect(captured).toBeNull();
});

test.each(["__proto__", "SYNTHETIC_UNKNOWN_CODE"])("unknown %s diagnostic is not echoed or interpreted", async code => {
  reset(); api.model.result = { ok: false, code };
  const message = await attempt();
  expect(message).toContain("неизвестный результат");
  expect(message).not.toContain(code);
  expect(captured).toBeNull();
});
