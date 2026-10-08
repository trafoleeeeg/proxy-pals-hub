import { test, expect } from "@playwright/test";
import type { fixture } from "./mock-api";
declare global { interface Window { fixture: typeof fixture } }

test("sleep/network recovery keeps profiles visible and does not close working tabs", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/app");
  await page.getByRole("button", { name: "Папка Работа", exact: true }).click();
  const profile = page.getByRole("button", { name: "Запустить Рабочий профиль", exact: true });
  await expect(profile).toBeVisible();
  await profile.click();
  await expect(page.getByRole("button", { name: "Закрыть Рабочий профиль", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    window.fixture.authOffline = true;
    window.fixture.networkFailures.push("listWorkspaces");
    await window.fixture.refreshWorkspaces();
    window.fixture.emitResume();
  });
  await expect(page.getByText("Нет связи с сервером", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Профили", exact: false })).toBeVisible();
  await expect(page.getByText("Не удалось загрузить рабочее пространство.", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.fixture.running.map(item => item.profileId))).toContain("p1");
  await page.evaluate(() => {
    window.fixture.authOffline = false;
    window.fixture.networkFailures = [];
    window.fixture.emitResume(); // No manual retry or online event required.
  });
  await expect(page.getByText("Нет связи с сервером", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Закрыть Рабочий профиль", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixture.calls.filter(item => item.method === "signOut"))).toEqual([]);
  expect(errors).toEqual([]);
});

test("a background update failure stays in Updates, not above the profiles table", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Профили", exact: false })).toBeVisible();
  await page.evaluate(() => window.fixture.emitUpdate({ state: "error", error: "fixture offline" }));
  await expect(page.getByText("Не удалось выполнить обновление.", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Приложение", exact: true }).click();
  await page.getByRole("link", { name: "Обновления", exact: true }).click();
  await expect(page.getByText("Не удалось выполнить обновление.", { exact: false }).first()).toBeVisible();
});

test("a server error during recovery shows a panel error and explicit retry reloads data", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Профили", exact: false })).toBeVisible();
  await page.evaluate(() => {
    window.fixture.failures.push("listWorkspaces");
    window.fixture.emitResume();
  });
  await expect(page.getByText("Не удалось восстановить панель", { exact: true })).toBeVisible();
  await expect(page.getByText("Нет связи с сервером", { exact: true })).toHaveCount(0);
  const failedCalls = await page.evaluate(() => window.fixture.calls.filter(item => item.method === "listWorkspaces").length);
  await page.evaluate(() => { window.fixture.failures = []; });
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByText("Не удалось восстановить панель", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.fixture.calls.filter(item => item.method === "listWorkspaces").length)).toBeGreaterThan(failedCalls);
  expect(await page.evaluate(() => window.fixture.calls.filter(item => item.method === "signOut"))).toEqual([]);
});
