const path = require("node:path");
const assert = require("node:assert/strict");
const { validateManifest, sha256 } = require("./panel-bundle.cjs");

function verifyPanelArchive(asar, archive, desktopVersion, platformPath = path) {
  // ASAR splits nested directories by path.sep. URL/manifest paths are POSIX,
  // so normalize every argument passed to its API, not just displayed names.
  const native = value => platformPath.normalize(value);
  const files = asar.listPackage(archive).map(name => name.split(platformPath.sep).join("/"));
  const manifest = validateManifest(JSON.parse(asar.extractFile(archive, native("panel/umbra-panel.json")).toString("utf8")), "", desktopVersion);
  const expected = new Set(["/panel/umbra-panel.json", ...manifest.files.map(file => "/panel" + file.path)]);
  for (const name of files) {
    if (name.startsWith("/panel/") && !asar.statFile(archive, native(name.slice(1))).files) {
      assert(expected.has(name), "Unexpected file in public panel bundle: " + name);
    }
  }
  for (const file of manifest.files) {
    const bytes = asar.extractFile(archive, native("panel" + file.path));
    assert.equal(bytes.length, file.size, "Packaged panel asset size mismatch");
    assert.equal(sha256(bytes), file.sha256, "Packaged panel asset integrity mismatch");
  }
  return manifest;
}
module.exports = { verifyPanelArchive };
