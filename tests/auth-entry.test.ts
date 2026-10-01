import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

describe("private account entry", () => {
  test("public auth has no signup branch, query-mode bypass, or account-creation link", () => {
    const auth = source("routes/auth.tsx");
    expect(auth).not.toMatch(/signUp|setMode|search\.mode|Зарегистрироваться/);
    expect(auth).toContain("Публичная регистрация временно закрыта");
    expect(source("routes/index.tsx")).not.toContain("Создать аккаунт");
  });
  test("explicit login uses verified persistent credentials then recreates identity caches", () => {
    const auth = source("routes/auth.tsx");
    expect(auth).toContain("await signInPrimaryAccount(toEmail(email), password)");
    expect(auth).toContain("window.location.replace(next)");
    expect(auth).not.toContain("navigate({");
    const root = source("routes/__root.tsx");
    expect(root).toContain("previousUserId !== userId) queryClient.clear()");
    expect(root).toContain("if (isPrimarySignInPending()) return;");
    expect(root).toContain("isPrimarySignInPending() || previousUserId !== userId");
    expect(root).not.toContain('window.location.replace("/app")');
  });
  test("account provisioning remains server-only and superadmin-protected", () => {
    const team = source("lib/team.functions.ts");
    const create = team.slice(team.indexOf("export const createEmployee"), team.indexOf("async function requireManagedEmployee"));
    expect(create).toContain(".middleware([requireSupabaseAuth])");
    expect(create.indexOf("await isSuperadmin(context)")).toBeLessThan(create.indexOf("supabaseAdmin.auth.admin.createUser"));
    expect(create).toContain("await requireTeamManager(context, data.teamId)");
    expect(create).toContain('role: "member", scope: "member"');
  });
});
