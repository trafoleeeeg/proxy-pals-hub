import { test, expect, type Page } from "@playwright/test";
import type { fixture } from "./mock-api";
declare global { interface Window { fixture: typeof fixture } }

async function showConflict(page: Page) {
  await page.goto("/app?scenario=cookie-recovery");
  await page.getByRole("button", { name: "Папка Работа", exact: true }).click();
  await page.getByRole("button", { name: "Запустить Рабочий профиль", exact: true }).click();
  await expect(page.getByRole("button", { name: "Восстановить: Рабочий профиль", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Повторить", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Восстановить: Рабочий профиль", exact: true }).click();
}

test("conflict opens an explicit cancellable choice and local recovery clears the dead end", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await showConflict(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Cookies: 2 · действующих: 1", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Cookies: 3 · действующих: 2", { exact: true })).toBeVisible();
  expect(await dialog.textContent()).not.toContain("mock-only");
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  expect(await page.evaluate(() => window.fixture.running)).toHaveLength(0);
  expect(await page.evaluate(() => window.fixture.recoveryBackups)).toHaveLength(0);
  await page.getByRole("button", { name: "Восстановить: Рабочий профиль", exact: true }).click();
  await dialog.getByRole("button", { name: "Восстановить локальную", exact: true }).click();
  await expect(page.getByRole("button", { name: "Закрыть Рабочий профиль", exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Восстановить: Рабочий профиль", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.fixture.recoveryBackups)).toHaveLength(1);
  expect(await page.evaluate(() => window.fixture.calls.filter(row => row.method === "nativeLaunch").at(-1)?.data.cookieRecovery.source)).toBe("local");
  expect(errors).toEqual([]);
});

test("changed data keeps the dialog open with a NEW choice", async ({ page }) => {
  await showConflict(page);
  await page.evaluate(() => { window.fixture.recoveryChanged = true; });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Восстановить локальную", exact: true }).click();
  await expect(dialog.getByText("Данные изменились после предыдущего выбора. Проверьте обновлённые версии.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Cookies: 4 · действующих: 2", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixture.running)).toHaveLength(0);
  await dialog.getByRole("button", { name: "Восстановить локальную", exact: true }).click();
  await expect(page.getByRole("button", { name: "Закрыть Рабочий профиль", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixture.calls.filter(row => row.method === "nativeLaunch").at(-1)?.data.cookieRecovery.receiptId)).toBe("10000000-0000-4000-8000-000000000009");
});

test("backup failure does not hide the conflict or claim the profile was recovered", async ({ page }) => {
  await showConflict(page);
  await page.evaluate(() => { window.fixture.recoveryFailure = true; });
  await page.getByRole("dialog").getByRole("button", { name: "Восстановить локальную", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(page.getByRole("button", { name: "Восстановить: Рабочий профиль", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixture.running)).toHaveLength(0);
  expect(await page.evaluate(() => window.fixture.recoveryBackups)).toHaveLength(0);
});

test("previous cloud copy can be explicitly restored from the encrypted backup", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await showConflict(page);
  await page.getByRole("dialog").getByRole("button", { name: "Восстановить локальную", exact: true }).click();
  await page.getByRole("button", { name: "Закрыть Рабочий профиль", exact: true }).click();
  await expect(page.getByRole("button", { name: "Запустить Рабочий профиль", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Действия Рабочий профиль", exact: true }).click();
  await page.getByRole("menuitem", { name: "Cookies", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Зашифрованный резерв восстановления", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Вернуть облачную", exact: true }).click();
  expect(await page.evaluate(() => window.fixture.running)).toHaveLength(0);
  await dialog.getByRole("button", { name: "Подтвердить возврат", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Закрыть Рабочий профиль", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixture.calls.filter(row => row.method === "nativeLaunch").at(-1)?.data.cookieRecovery.source)).toBe("cloud");
  expect(await page.evaluate(() => window.fixture.recoveryBackups)).toHaveLength(2);
  expect(errors).toEqual([]);
});
