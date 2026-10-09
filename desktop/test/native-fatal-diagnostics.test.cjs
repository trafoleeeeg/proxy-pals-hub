const test = require("node:test");
const assert = require("node:assert/strict");
const { createNativeFatalParser } = require("../runtime/native-fatal-diagnostics.cjs");

test("fatal markers survive every byte boundary and emit only fixed categories without waiting for EOF", () => {
  const categories = [];
  const parse = createNativeFatalParser(category => categories.push(category));
  const input = Buffer.from("[123:456:1009/160700.123:FATAL:private/path/private.cc(42)] https://private.example Authorization: secret\r\n"
    + "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory secret");
  for (const byte of input) parse(Buffer.from([byte]));
  assert.deepEqual(categories, ["native-fatal", "v8-oom"]);
  assert.doesNotMatch(JSON.stringify(categories), /private|https|secret|Authorization|\.cc/);
});

test("stderr parser ignores ordinary messages, stack symbols and fatal-like text away from line start", () => {
  const categories = [];
  const parse = createNativeFatalParser(category => categories.push(category));
  parse(Buffer.from("normal secret output FATAL ERROR: JavaScript heap out of memory\n"
    + "[123:456:1009/160700.123:ERROR:private.cc(42)] FATAL: private\n"
    + "1: 0xdeadbeef v8::FatalProcessOutOfMemory(secret)\n"
    + "https://private.example/FATAL\n"));
  assert.deepEqual(categories, []);
});

test("oversized lines have a bounded prefix and parsing resumes only after their newline", () => {
  const categories = [];
  const parse = createNativeFatalParser(category => categories.push(category));
  const block = Buffer.alloc(64 * 1024, 120);
  for (let index = 0; index < 128; index++) parse(block);
  parse(Buffer.from("# Fatal process out of memory: private\n"));
  assert.deepEqual(categories, []);
  parse(Buffer.from("# Fatal process out of memory: private\n" + "secret".repeat(20000) + "\n"));
  parse(Buffer.from("# Fatal error in private/path.cc, line 12\n"));
  assert.deepEqual(categories, ["v8-oom", "native-fatal"]);
});

test("fatal categories are limited to one event each even with repeated lines", () => {
  const categories = [];
  const parse = createNativeFatalParser(category => categories.push(category));
  for (let index = 0; index < 100; index++) parse(Buffer.from("# Fatal process out of memory: private\n# Fatal error in secret.cc\n"));
  assert.deepEqual(categories, ["v8-oom", "native-fatal"]);
});

test("diagnostic callback errors do not escape into the coordinator", () => {
  const parse = createNativeFatalParser(() => { throw new Error("diagnostic unavailable"); });
  assert.doesNotThrow(() => parse(Buffer.from("# Fatal process out of memory: private\n# Fatal error in private.cc\n")));
});
