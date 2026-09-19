import { createMiddleware } from "@tanstack/react-start";
import { getUsableSession } from "./auth-session";

// The generated middleware trusts local storage. The desktop panel can stay
// open for days, so refresh its persisted token before protected server calls.
export const attachFreshSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const token = (await getUsableSession())?.access_token;
    return next({ headers: token ? { Authorization: `Bearer ${token}` } : {} });
  },
);
