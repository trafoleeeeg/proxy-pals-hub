const { createProfileRuntime } = require("./runtime/profile-runtime.cjs");
module.exports = createProfileRuntime(require("electron"));
