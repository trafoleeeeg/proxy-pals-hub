import { fixture } from "./mock-api";
const channel = { on: () => channel, subscribe: () => channel };
export const supabase = {
  channel: () => channel, removeChannel: async () => {},
  auth: { signOut: async () => { fixture.calls.push({ method: "signOut", data: {} }); return { error: null }; } },
};
export const primaryClient = supabase;
export const sessionFetch = () => fetch;
