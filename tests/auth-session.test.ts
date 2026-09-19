import { describe, expect, test } from "bun:test";
import { isDefinitiveAuthFailure, sessionNeedsRefresh } from "../src/integrations/supabase/auth-session";

describe("persisted authentication session", () => {
  test("refreshes expired and nearly expired tokens before protected requests", () => {
    const now = Date.parse("2026-09-19T09:00:00Z");
    expect(sessionNeedsRefresh({ expires_at: now / 1_000 - 1 }, now)).toBe(true);
    expect(sessionNeedsRefresh({ expires_at: now / 1_000 + 30 }, now)).toBe(true);
    expect(sessionNeedsRefresh({ expires_at: now / 1_000 + 120 }, now)).toBe(false);
  });

  test("distinguishes rejected credentials from a temporary network failure", () => {
    expect(isDefinitiveAuthFailure({ status: 401, message: "JWT expired" })).toBe(true);
    expect(isDefinitiveAuthFailure({ code: "refresh_token_not_found" })).toBe(true);
    expect(isDefinitiveAuthFailure({ status: 0, message: "Failed to fetch" })).toBe(false);
  });
});
