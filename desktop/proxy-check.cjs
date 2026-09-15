const { createProxyChecker } = require("./runtime/proxy-probe.cjs");
module.exports = { checkProxy: createProxyChecker(require("electron")) };
