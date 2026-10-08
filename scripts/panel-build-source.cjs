const fs = require("node:fs");
const path = require("node:path");

function resolveBuildOutput(root, env = process.env) {
  // Match vite-tanstack-config's sandbox detection. Never mix the current
  // client with a stale server (or fall back to a previous build directory).
  const sandbox = env.LOVABLE_SANDBOX === "1" || !!env.DEV_SERVER__PROJECT_PATH;
  const directory = sandbox ? "dist" : ".output";
  return {
    publicDirectory: path.join(root, directory, sandbox ? "client" : "public"),
    serverEntry: path.join(root, directory, "server/index.mjs"),
  };
}

function validateAnonymousShell(shell) {
  // Root-only state, or pending protected matches from newer TanStack builds.
  const matches = [...shell.matchAll(/\{i:"([^"]*)",u:\d+,s:"(\w+)",ssr:(!0|!1)/g)];
  const isRoot = id => /^__root__(?:\u0000|\\u0000)?$/.test(id);
  if (!matches.some(([, id, status, ssr]) => isRoot(id) && status === "success" && ssr === "!0")
    || matches.some(([, id, status, ssr]) => !isRoot(id) && (ssr === "!0" || status === "success"))
    || /access_token|refresh_token|cookies_enc/.test(shell)) {
    throw new Error("Panel shell must be anonymous");
  }
  return shell;
}

async function renderAnonymousShell(handler) {
  const response = await handler.fetch(new Request("https://localhost/app", {
    headers: { "X-TSS_SHELL": "true", Accept: "text/html" }, redirect: "manual",
  }), {}, { waitUntil() {}, passThroughOnException() {} });
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/html")) {
    throw new Error("Panel shell render failed: " + response.status);
  }
  return validateAnonymousShell(await response.text());
}

function assertShellTarget(target) {
  if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) {
    // Do not delete a directory/symlink supplied by an unexpected build.
    throw new Error("Panel shell output must be a regular file");
  }
}

module.exports = { resolveBuildOutput, validateAnonymousShell, renderAnonymousShell, assertShellTarget };
