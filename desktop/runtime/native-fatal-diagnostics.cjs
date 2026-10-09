// Retain only a small line prefix in memory. Neither the line nor any source
// path, symbol, URL or error message is passed to the diagnostic writer.
const MAX_PREFIX_BYTES = 1024;

function createNativeFatalParser(onFatal) {
  let prefix = Buffer.alloc(0);
  const reported = new Set();
  const report = (category) => {
    if (reported.has(category)) return;
    reported.add(category);
    try { onFatal(category); } catch { /* Diagnostics must not affect the child. */ }
  };
  return (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      if (prefix.length < MAX_PREFIX_BYTES) {
        const part = bytes.subarray(offset, Math.min(end, offset + MAX_PREFIX_BYTES - prefix.length));
        prefix = Buffer.concat([prefix, part]);
        const text = prefix.toString("latin1");
        // Recognize markers before EOF as the coordinator exits immediately
        // with its child. No shutdown or stream-draining behavior is changed.
        if (/^\[[^\]\r\n]{1,128}:FATAL:[^\]\r\n]{1,512}\]/.test(text) || /^# Fatal error in\b/.test(text)) report("native-fatal");
        if (/^# Fatal process out of memory:/.test(text)
          || /^FATAL ERROR: [^\r\n]*\b(?:JavaScript heap out of memory|process out of memory)\b/.test(text)) report("v8-oom");
      }
      if (newline === -1) break;
      prefix = Buffer.alloc(0);
      offset = newline + 1;
    }
  };
}

module.exports = { createNativeFatalParser };
