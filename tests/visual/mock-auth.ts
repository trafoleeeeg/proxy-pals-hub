import { fixture } from "./mock-api";
const channel = { on: () => channel, subscribe: () => channel };
const user = { id: "owner", email: "owner@example.com" };
const session = () => ({ user, access_token: "fixture-token", expires_at: Date.now() / 1000 + 3600 });
export const supabase = {
  channel: () => channel, removeChannel: async () => {},
  auth: {
    getSession: async () => ({ data: { session: session() }, error: null }),
    getUser: async () => ({ data: { user: fixture.authOffline ? null : user }, error: fixture.authOffline ? { status: 503 } : null }),
    refreshSession: async () => ({ data: { session: session() }, error: null }),
    signOut: async () => { fixture.calls.push({ method: "signOut", data: {} }); return { error: null }; },
  },
};
export const primaryClient = supabase;
export const sessionFetch = () => fetch;
