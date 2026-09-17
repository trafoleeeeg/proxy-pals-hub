const fs = require("node:fs");
const path = require("node:path");
// Bundle the panel's design tokens so native and web UI share one color source.
const packaged = path.join(__dirname, "..", "theme", "styles.css");
const source = fs.existsSync(packaged) ? packaged : path.join(__dirname, "..", "..", "src", "styles.css");
const tokens = fs.readFileSync(source, "utf8").match(/:root\s*\{[\s\S]*?\}/)?.[0];
if (!tokens) throw new Error("Application theme is missing");
module.exports = { tokens };
