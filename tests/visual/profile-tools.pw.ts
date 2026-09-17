import { test, expect } from "@playwright/test";

test("proxy IP transition and explicit clipboard paste are visible", async ({ page }) => {
  await page.goto("/app/proxies");
  await expect(page.getByText("Был: 203.0.113.1", { exact: true })).toBeVisible();
  await expect(page.getByText("Стал: 203.0.113.2", { exact: true })).toBeVisible();
  await expect(page.getByText("Последняя смена:", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Импорт", exact: true }).click();
  await page.getByRole("button", { name: "Вставить из буфера", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Список прокси" })).toHaveValue("proxy.example:8080");
});

test("legacy clients remain usable; new clients add and remove extension presets", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/app/desktop");
  await expect(page.getByText("Обновите приложение Windows, чтобы управлять расширениями.")).toBeVisible();
  await page.goto("/app/desktop?scenario=extensions");
  await page.getByRole("button", { name: "Добавить расширение", exact: true }).click();
  await expect(page.getByText("Новое расширение", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Удалить Новое расширение", exact: true }).click();
  await expect(page.getByText("Новое расширение", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
