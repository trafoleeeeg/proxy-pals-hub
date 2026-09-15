import { fixture } from "./mock-api";
export const supabase = { auth: { signOut: async () => { fixture.calls.push({ method: "signOut", data: {} }); return { error: null }; } } };
