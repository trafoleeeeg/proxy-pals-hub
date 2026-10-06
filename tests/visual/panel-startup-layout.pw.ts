import { test, expect } from "@playwright/test";

test("workspace selectors coalesce startup queries and sidebar collapse survives section navigation", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/app");
  const sidebar = page.getByRole("complementary", { name: "Боковая панель" });
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Развернуть меню" }).click();
  await expect(sidebar.getByText("owner@example.com", { exact: true })).toBeVisible();
  const workspaceCalls = () => page.evaluate(() => window.fixture.calls.filter(call => call.method === "listWorkspaces").length);
  expect(await workspaceCalls()).toBe(1);
  expect(await page.evaluate(() => window.fixture.calls.filter(call => call.method === "getWorkspace").length)).toBe(0);
  await sidebar.getByRole("combobox", { name: "Рабочая команда" }).click();
  await page.getByRole("option", { name: "Вторая команда" }).click();
  await expect(sidebar.getByRole("combobox", { name: "Рабочая команда" })).toHaveText("Вторая команда");
  expect(await workspaceCalls()).toBe(1);
  await page.getByRole("button", { name: "Свернуть меню" }).click();
  for (const section of ["Прокси", "Команда", "Папки", "Корзина", "Профили"]) {
    await sidebar.getByRole("link", { name: section, exact: true }).click();
    await expect(page.getByRole("button", { name: "Развернуть меню" })).toBeVisible();
    const size = await page.locator("html").evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth }));
    expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
  }
  await page.getByRole("button", { name: "Развернуть меню" }).click();
  await expect(sidebar.getByRole("combobox", { name: "Рабочая команда" })).toHaveText("Вторая команда");
  expect(await workspaceCalls()).toBe(1);
  expect(errors).toEqual([]);
});
