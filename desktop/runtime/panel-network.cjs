// Panel RPC only: finite responses, no private-data cache and no write replay.
async function fetchPanelResponse(fetcher, request, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("Panel request timed out", "TimeoutError");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetcher(request, { ...options, signal });
      if (!response.body) return response;
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    })(), deadline]);
  } finally { clearTimeout(timer); }
}

module.exports = { fetchPanelResponse };
