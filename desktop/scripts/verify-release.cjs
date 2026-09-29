const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const yaml = require("js-yaml");
const pkg = require("../package.json");
const { verifyEngine } = require("./verify-engine.cjs");
const { verifyFontBundle } = require("../runtime/font-isolation.cjs");

async function verifyRelease(directory = path.join(__dirname, "../dist")) {
  await verifyEngine();
  const manifest = yaml.load(fs.readFileSync(path.join(directory, "latest.yml"), "utf8"));
  assert.equal(manifest.version, pkg.version, "Updater version differs from package version");
  const expected = "Umbra-Setup-" + pkg.version + "-x64.exe";
  assert.equal(manifest.path, expected, "Updater must reference the NSIS installer");
  assert.equal(manifest.files.length, 1, "Exactly one Windows installer is expected");
  const file = manifest.files[0];
  assert.equal(file.url, expected);
  const target = path.join(directory, expected);
  assert.equal(fs.statSync(target).size, file.size);
  const hash = createHash("sha512");
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  const digest = hash.digest("base64");
  assert.equal(file.sha512, digest, "Installer SHA-512 mismatch");
  assert.equal(manifest.sha512, digest, "Legacy updater SHA-512 mismatch");
  assert(fs.statSync(target + ".blockmap").size > 0, "Missing differential update blockmap");
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false, "Profile data must survive updates");
  const archive = path.join(directory, "win-unpacked/resources/app.asar");
  const executable = path.join(directory, "win-unpacked/Umbra.exe");
  if (fs.existsSync(executable)) {
    const markers = ["setUmbraScreenMetrics", "setUmbraHardwareMetrics", "setUmbraFontIsolation"].map(value => Buffer.from(value));
    const markerLength = Math.max(...markers.map(marker => marker.length));
    const fd = fs.openSync(executable, "r");
    const found = new Set();
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024 + markerLength);
      let overlap = 0;
      let read;
      while ((read = fs.readSync(fd, buffer, overlap, 1024 * 1024, null)) > 0) {
        for (const marker of markers) if (buffer.subarray(0, overlap + read).includes(marker)) found.add(marker);
        if (found.size === markers.length) break;
        const total = overlap + read;
        const nextOverlap = Math.min(markerLength - 1, total);
        buffer.copyWithin(0, total - nextOverlap, total);
        overlap = nextOverlap;
      }
    } finally { fs.closeSync(fd); }
    assert.equal(found.size, markers.length, "Packaged Umbra.exe must contain native screen, hardware and font APIs");
    const fonts = path.join(directory, "win-unpacked/resources/isolated-fonts");
    await verifyFontBundle(fonts);
    for (const notice of ["LICENSE.txt", "NOTICE.txt"]) {
      const supplied = fs.readFileSync(path.join(fonts, notice), "utf8").replace(/\r\n/g, "\n");
      const original = fs.readFileSync(path.join(__dirname, "../assets/isolated-fonts", notice), "utf8").replace(/\r\n/g, "\n");
      assert.equal(supplied, original, "Font license/notice changed during packaging");
    }
  }
  if (fs.existsSync(archive)) {
    const asar = require("@electron/asar");
    const files = new Set(asar.listPackage(archive).map((name) => name.split(path.sep).join("/")));
    for (const name of ["/extensions.cjs", "/runtime/profile-home.cjs", "/runtime/theme.cjs", "/theme/styles.css", "/runtime/browser-pipe.cjs", "/runtime/background-workers.cjs", "/runtime/fingerprint.cjs", "/fingerprint-preload.cjs", "/runtime/font-isolation.cjs", "/engine/font-bundle-lock.json"]) {
      assert(files.has(name), "Packaged application is missing " + name);
    }
    assert.deepEqual(JSON.parse(asar.extractFile(archive, "engine/font-bundle-lock.json").toString("utf8")),
      require("../engine/font-bundle-lock.json"), "Packaged font manifest differs from the verified source");
    assert.equal(JSON.parse(asar.extractFile(archive, "package.json").toString("utf8")).version, pkg.version);
  }
  console.log("Verified Windows installer, version, SHA-512 and blockmap: " + expected);
}
if (require.main === module) verifyRelease(process.argv[2]).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { verifyRelease };
