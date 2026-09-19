import { describe, expect, test } from "bun:test";
import { isDefinitiveAuthFailure, sessionNeedsRefresh, withAuthTimeout } from "../src/lib/auth-session";
import { isUnauthorizedServerError, unauthorizedResponse } from "../src/lib/auth-response";

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

  test("stops waiting when the authentication service does not answer", async () => {
    const never = new Promise<never>(() => {});
    await expect(withAuthTimeout(never, 5)).rejects.toThrow("Сервер авторизации не ответил вовремя");
  });

  test("keeps unauthorized failures as HTTP 401 instead of a generic server error", async () => {
    expect(isUnauthorizedServerError(new Error("Unauthorized: Invalid token"))).toBe(true);
    expect(isUnauthorizedServerError(new Error("offline"))).toBe(false);
    const response = unauthorizedResponse();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});
