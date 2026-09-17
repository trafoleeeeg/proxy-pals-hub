const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");
const yaml = require("js-yaml");
const pkg = require("../package.json");

async function verifyRelease(directory = path.join(__dirname, "../dist")) {
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
  if (fs.existsSync(archive)) {
    const asar = require("@electron/asar");
    const files = new Set(asar.listPackage(archive).map((name) => name.split(path.sep).join("/")));
    for (const name of ["/extensions.cjs", "/runtime/profile-home.cjs", "/runtime/theme.cjs", "/theme/styles.css"]) {
      assert(files.has(name), "Packaged application is missing " + name);
    }
  }
  console.log("Verified Windows installer, version, SHA-512 and blockmap: " + expected);
}
if (require.main === module) verifyRelease(process.argv[2]).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { verifyRelease };
