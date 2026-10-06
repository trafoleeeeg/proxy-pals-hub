import { test, expect } from "@playwright/test";

test("migration preview requires acknowledgement, applies only supported settings and preserves privacy", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/app");
  await page.getByRole("button", { name: "Новый профиль", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Перенос настроек из Octo · Windows", { exact: true }).click();
  const privacy = dialog.getByRole("switch", { name: "Агрессивная блокировка API" });
  await privacy.check();
  await dialog.getByRole("button", { name: "Образец TG CHANNEL" }).click();
  await expect(dialog.getByText(/32 ГБ в настройках не доказывают/)).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Совместимость переноса" }).getByText(/RTX 4060/)).toBeVisible();
  const apply = dialog.getByRole("button", { name: "Применить поддерживаемые настройки" });
  await expect(apply).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /Понимаю ограничения/ }).check();
  await apply.click();
  await expect(dialog.getByRole("spinbutton", { name: "Ширина экрана" })).toHaveValue("1600");
  await expect(dialog.getByRole("spinbutton", { name: "Высота экрана" })).toHaveValue("900");
  await expect(dialog.getByRole("spinbutton", { name: "Логические потоки процессора" })).toHaveValue("12");
  await expect(privacy).toBeChecked();
  await expect(apply).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Публичные настройки источника" }).fill(JSON.stringify({
    format: "umbra-settings-v1", os: "windows", osVersion: "11", deviceMemory: 8,
    languages: ["de-DE", "de"], timezone: "Europe/Berlin",
  }));
  await dialog.getByRole("checkbox", { name: /Понимаю ограничения/ }).check();
  await apply.click();
  await expect(dialog.getByRole("textbox", { name: "Основной язык" })).toHaveValue("de-DE");
  await expect(dialog.getByRole("textbox", { name: "Часовой пояс", exact: true })).toHaveValue("Europe/Berlin");
  await dialog.getByRole("textbox", { name: "Публичные настройки источника" }).fill('{"cookies":[]}');
  await expect(dialog.getByRole("alert").filter({ hasText: "Неверные или неизвестные поля" })).toBeVisible();
  await expect(apply).toHaveCount(0);
  const size = await page.locator("html").evaluate(el => ({ scroll: el.scrollWidth, width: el.clientWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
  expect(errors).toEqual([]);
});
