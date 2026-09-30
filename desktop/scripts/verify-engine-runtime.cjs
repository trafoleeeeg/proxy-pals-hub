const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const lock = require("../engine/source-lock.json");

function verify(executable) {
  const output = execFileSync(path.resolve(executable), [
    "-p", "JSON.stringify({electron:process.versions.electron,chromium:process.versions.chrome,node:process.versions.node})",
  ], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const actual = JSON.parse(output.trim());
  assert.equal(actual.electron, lock.electron.tag.slice(1), "Archive has a different Electron runtime");
  assert.equal(actual.chromium, lock.chromium.tag, "Archive has a different Chromium runtime");
  assert.equal(actual.node, lock.node.tag.slice(1), "Archive has a different Node.js runtime");
  console.log("Verified actual Electron/Chromium/Node runtime: " +
    actual.electron + " / " + actual.chromium + " / " + actual.node);
}

if (require.main === module) {
  try {
    assert(process.argv[2], "Pass the extracted electron.exe path");
    verify(process.argv[2]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verify };
