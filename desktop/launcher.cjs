const { createProfileRuntime } = require("./runtime/profile-runtime.cjs");
const electron = require("electron");
const { createExtensionStore } = require("./extensions.cjs");
const extensionStore = createExtensionStore(() => electron.app.getPath("userData"));
const { checkProxy } = require("./proxy-check.cjs");
const { createLeakAudit } = require("./runtime/leak-check.cjs");
const auditLeaks = createLeakAudit({ session: electron.session, net: electron.net });
const runtime = createProfileRuntime(electron, { extensionStore, checkProxy, auditLeaks,
  onBrowserSettingsChanged: (settings) => electron.app.emit("umbra:browser-settings-changed", settings),
});
module.exports = Object.assign(runtime, { extensionStore });
