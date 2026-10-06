const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { sha256 } = require("../runtime/panel-bundle.cjs");
const { verifyPanelArchive } = require("../runtime/panel-archive.cjs");

function fixture(platformPath) {
  const manifest = { schema: 1, minimumDesktopVersion: "0.4.43", entry: "/_umbra-panel.html", revision: "2026-10-06T00:00:00.000Z", files: [] };
  const contents = new Map();
  for (const resource of ["/_umbra-panel.html", "/assets/app.agents-fixture.js"]) {
    const bytes = Buffer.from("public-fixture");
    contents.set(platformPath.normalize("panel" + resource), bytes);
    manifest.files.push({ path: resource, size: bytes.length, sha256: sha256(bytes) });
  }
  contents.set(platformPath.normalize("panel/umbra-panel.json"), Buffer.from(JSON.stringify(manifest)));
  const directories = new Set(["panel", platformPath.normalize("panel/assets")]);
  const asar = {
    listPackage: () => [...directories, ...contents.keys()].map(name => platformPath.join("/", name)),
    statFile: (_archive, name) => {
      if (directories.has(name)) return { files: {} };
      assert(contents.has(name), "ASAR API requires native separators: " + name);
      return { size: contents.get(name).length };
    },
    extractFile: (_archive, name) => {
      assert(contents.has(name), "ASAR API requires native separators: " + name);
      return contents.get(name);
    },
  };
  return { asar, contents, manifest };
}

for (const [platform, platformPath] of [["Windows", path.win32], ["POSIX", path.posix]]) {
  test(platform + " verifies nested ASAR resources with native separators", () => {
    const f = fixture(platformPath);
    if (platform === "Windows") assert.throws(() => f.asar.extractFile("fixture", "panel/assets/app.agents-fixture.js"), /native separators/);
    assert.deepEqual(verifyPanelArchive(f.asar, "fixture", "0.4.43", platformPath), f.manifest);
  });
  test(platform + " rejects missing/tampered and unlisted archive files", () => {
    const f = fixture(platformPath);
    const target = platformPath.normalize("panel/assets/app.agents-fixture.js");
    f.contents.set(target, Buffer.from("tampered"));
    assert.throws(() => verifyPanelArchive(f.asar, "fixture", "0.4.43", platformPath), /size mismatch/);
    f.contents.set(target, Buffer.from("public-fixture"));
    f.contents.delete(target);
    assert.throws(() => verifyPanelArchive(f.asar, "fixture", "0.4.43", platformPath));
    f.contents.set(target, Buffer.from("public-fixture"));
    f.contents.set(platformPath.normalize("panel/not-listed.txt"), Buffer.from("fixture"));
    assert.throws(() => verifyPanelArchive(f.asar, "fixture", "0.4.43", platformPath), /Unexpected file/);
  });
}
