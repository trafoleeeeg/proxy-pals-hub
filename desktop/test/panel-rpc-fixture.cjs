const assert = require("node:assert/strict");
const path = require("node:path");
const https = require("node:https");
const { gzipSync } = require("node:zlib");
const fs = require("node:fs");
const { testCertificate } = require("./runtime-proxy-fixtures.cjs");
const { createPanelBundle } = require("../runtime/panel-bundle.cjs");

async function runPanelRpcFixture({ app, BrowserWindow, session }) {
  let origin;
  const certificateDirectory = path.join(app.getPath("userData"), "rpc-tls-fixture");
  fs.mkdirSync(certificateDirectory, { recursive: true });
  const certificate = testCertificate(certificateDirectory);
  let rpcHits = 0;
  const server = https.createServer(certificate, (request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      rpcHits++;
      const valid = request.headers.origin === origin && request.headers["sec-fetch-site"] === "same-origin"
        && request.headers.authorization === "Bearer synthetic-rpc-only" && body === "fixture-body";
      response.writeHead(valid ? 200 : 403, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Access-Control-Allow-Origin": origin });
      response.end(gzipSync(JSON.stringify({ ok: valid })));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${server.address().port}`;
  try {
    const rpcSession = session.fromPartition("isolated-panel-rpc-test");
    rpcSession.setCertificateVerifyProc((request, callback) => callback(request.hostname === "127.0.0.1"
      && request.certificate.data.trim() === certificate.cert.toString().trim() ? 0 : -3));
    const bundle = createPanelBundle({ origin, bundledDirectory: path.join(__dirname, "../.panel"),
      cacheDirectory: path.join(app.getPath("userData"), "unused-rpc-cache"), safeStorage: null,
      panelSession: rpcSession,
    });
    rpcSession.protocol.unhandle("https");
    let nativeOrigin = false;
    rpcSession.protocol.handle("https", request => {
      if (new URL(request.url).pathname === "/rpc-fixture") return new Response("<!doctype html><p>RPC fixture</p>", { headers: { "Content-Type": "text/html" } });
      if (new URL(request.url).pathname === "/_serverFn/fixture" && request.headers.has("authorization")) {
        nativeOrigin = Object.hasOwn(request, "initiatorOrigin") && request.initiatorOrigin === origin;
      }
      return bundle.handler(request);
    });
    const window = new BrowserWindow({ show: false, webPreferences: { session: rpcSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await window.loadURL(origin + "/rpc-fixture");
      const result = await window.webContents.executeJavaScript(`fetch('/_serverFn/fixture', {method:'POST',headers:{Authorization:'Bearer synthetic-rpc-only'},body:'fixture-body'}).then(async r=>({status:r.status,body:await r.text()}))`);
      // Inspect actual native request provenance, not an unrelated graphics API.
      // Upstream Electron can also expose initiatorOrigin without Umbra APIs.
      if (process.platform === "win32") assert(nativeOrigin, "Pinned Windows engine must supply native RPC provenance");
      assert.equal(result.status, nativeOrigin ? 200 : 403, "Actual forwarded RPC must retain CSRF metadata on the pinned engine");
      assert.equal(rpcHits, nativeOrigin ? 1 : 0);
      if (nativeOrigin) assert.deepEqual(JSON.parse(result.body), { ok: true });
      const opaqueScript = `fetch(${JSON.stringify(origin + "/_serverFn/fixture")},{method:'POST',mode:'no-cors',body:'opaque-fixture'}).then(()=>parent.postMessage('opaque-rpc-finished','*')).catch(()=>parent.postMessage('opaque-rpc-finished','*'))`;
      const opaque = await window.webContents.executeJavaScript(`new Promise(resolve=>{
        const timer=setTimeout(()=>resolve('timeout'),3000);
        addEventListener('message',event=>{if(event.data==='opaque-rpc-finished'){clearTimeout(timer);resolve('finished')}},{once:true});
        const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');
        frame.srcdoc=${JSON.stringify("<script>"+opaqueScript+"</script>")};document.body.append(frame);
      })`);
      assert.equal(opaque, "finished", "Opaque iframe fixture must actually execute its request");
      assert.equal(rpcHits, nativeOrigin ? 1 : 0, "Opaque iframe cannot borrow its parent's trusted referrer to bypass CSRF");
      return { status: result.status, rpcHits, nativeOrigin };
    } finally { window.destroy(); }
  } finally { await new Promise(resolve => server.close(resolve)); }
}
module.exports = { runPanelRpcFixture };
