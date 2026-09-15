import { createServer } from "vite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const server = await createServer({
  configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
  server: { port: 4179, strictPort: true },
});
try {
  await server.listen();
  const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "tests/visual/playwright.config.ts", ...process.argv.slice(2)], { cwd: root, stdio: "inherit", windowsHide: true });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await server.close();
  console.log("Fixture server stopped (127.0.0.1:4179).");
}
// Native build workers can keep Node alive on Windows after Vite has closed.
process.exit(process.exitCode ?? 0);
