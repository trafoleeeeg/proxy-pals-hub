const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const pkg = require("../package.json");
const lock = require("../engine/source-lock.json");

async function verifyEngine({ release = false } = {}) {
  const spec = lock.distribution?.windowsX64;
  assert.equal(pkg.build.electronDist, ".engine/dist.zip", "Windows packaging must use the pinned custom Electron archive");
  assert.equal(lock.appIntegrationEnabled, true, "Native screen integration is disabled");
  assert.equal(lock.nativeScreenApi, "session.setUmbraScreenMetrics");
  assert.match(spec?.releaseTag || "", /^umbra-engine-v\d+\.\d+\.\d+-screen\d+$/);
  assert.equal(spec.asset, "dist.zip");
  assert.match(spec.sha256, /^[a-f0-9]{64}$/);
  if (release) assert.equal(lock.status, "release-approved", "Experimental test engine must not be published as a stable Umbra update");
  const archive = path.resolve(__dirname, "..", pkg.build.electronDist);
  const stats = fs.statSync(archive);
  assert(stats.size > 50 * 1024 * 1024, "Custom Electron archive is unexpectedly small");
  const digest = createHash("sha256");
  for await (const chunk of fs.createReadStream(archive)) digest.update(chunk);
  assert.equal(digest.digest("hex"), spec.sha256, "Custom Electron archive does not match the pinned SHA-256");
  console.log("Verified pinned custom Electron archive: " + spec.releaseTag);
}

if (require.main === module) verifyEngine({ release: process.argv.includes("--release") }).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { verifyEngine };
