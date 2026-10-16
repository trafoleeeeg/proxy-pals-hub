const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const source = file => fs.readFileSync(path.join(root, file), "utf8");

test("hosting cutover preserves application identity and every profile/outbox namespace", () => {
  const pkg = JSON.parse(source("desktop/package.json"));
  assert.equal(pkg.name, "umbra-desktop");
  assert.equal(pkg.build.productName, "Umbra");
  assert.equal(pkg.build.appId, "dev.umbra.desktop");
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
  const main = source("desktop/main.cjs");
  assert(main.includes('app.setAppUserModelId("dev.umbra.desktop")'));
  assert(main.includes('partition: "persist:umbra-app"'));
  assert(main.includes('createSessionOutbox(path.join(app.getPath("userData"), "session-outbox"), safeStorage)'));
  assert(source("desktop/runtime/profile-runtime.cjs").includes('partition: `persist:profile-${id}`'));
  assert(source("desktop/runtime/browser-pipe.cjs").includes('const persistentUserData = app.getPath("userData")'));
  for (const [file, directory] of [["cookies", "profile-cookie-snapshots"], ["cookie-recovery", "profile-cookie-recovery"], ["tabs", "profile-tab-snapshots"], ["bookmarks", "profile-bookmarks"]]) {
    assert(source(`desktop/runtime/${file}.cjs`).includes(`path.join(userData, "${directory}")`));
  }
  const privacy = source("desktop/runtime/privacy-policy.cjs");
  assert(privacy.includes('"profile-extension-consent" : "profile-privacy"'));
});

test("desktop CI builds target public configuration explicitly and retains engine release gates", () => {
  const workflow = source(".github/workflows/desktop-windows.yml");
  assert.equal(workflow.match(/VITE_SUPABASE_URL: \$\{\{ vars\.UMBRA_SUPABASE_URL \}\}/g)?.length, 2);
  assert.equal(workflow.match(/VITE_SUPABASE_PUBLISHABLE_KEY: \$\{\{ vars\.UMBRA_SUPABASE_PUBLISHABLE_KEY \}\}/g)?.length, 2);
  assert.equal(workflow.match(/node scripts\/build-cloudflare\.cjs/g)?.length, 2);
  assert(!workflow.includes("bun run build\n"), "No fallback to legacy .env panel build");
  assert(!/secrets\.(?:APP_ENCRYPTION_KEY|SUPABASE_SERVICE_ROLE_KEY)/.test(workflow));
  for (const gate of ["node desktop/scripts/verify-engine.cjs --release", "node desktop/scripts/verify-engine-runtime.cjs", "UMBRA_REQUIRE_NATIVE", "UMBRA_REQUIRE_DPAPI", "npm run verify:release"]) assert(workflow.includes(gate));
  const builder = source("scripts/build-cloudflare.cjs");
  assert(builder.includes("cloudflareBuildEnvironment(environment)"));
  assert(builder.includes('throw new Error(`Cloudflare build requires ${name} in the build environment`)'));
  assert(source("vite.config.ts").includes("envDir: false"));
});
