const { app, crashReporter } = require("electron");
const { startNativeCrashCapture } = require("../runtime/native-crash-capture.cjs");
// Deliberately crash only an isolated fixture process, with no real profile,
// cookies, network connections or working application's single-instance lock.
app.setPath("userData", process.env.UMBRA_CAPTURE_TEST_DATA);
if (!startNativeCrashCapture({ app, crashReporter }, "browser") || crashReporter.getUploadToServer()) {
  process.stderr.write("CAPTURE_SETUP_FAILED\n");
  app.exit(81);
} else {
  process.stdout.write("CAPTURE_LOCAL_ONLY\n");
  app.whenReady().then(() => setTimeout(() => process.crash(), 100));
}
