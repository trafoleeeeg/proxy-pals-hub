import { createMiddleware } from "@tanstack/react-start";
import { expireLocalSession, forceRefreshSession, getUsableSession } from "./auth-session";

function authorization(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function requestWithAuthorization(input: RequestInfo | URL, init: RequestInit | undefined, token: string) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  headers.set("Authorization", `Bearer ${token}`);
  return new Request(input, { ...init, headers });
}

// The desktop panel can stay open for days. If the backend rejects a token
// that still looks current locally, refresh it once and replay that request.
export const attachFreshSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const session = await getUsableSession();
    if (!session) {
      await expireLocalSession();
      throw new Error("Сессия истекла. Войдите снова.");
    }
    const authenticatedFetch: typeof fetch = async (input, init) => {
      const firstRequest = requestWithAuthorization(input, init, session.access_token);
      const retryRequest = firstRequest.clone();
      const response = await fetch(firstRequest);
      if (response.status !== 401) return response;
      try {
        const refreshed = await forceRefreshSession();
        const retryResponse = await fetch(requestWithAuthorization(retryRequest, undefined, refreshed.access_token));
        if (retryResponse.status === 401) await expireLocalSession();
        return retryResponse;
      } catch (error) {
        await expireLocalSession();
        throw error;
      }
    };
    return next({ headers: authorization(session.access_token), fetch: authenticatedFetch });
  },
);