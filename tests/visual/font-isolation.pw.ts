import { test, expect } from "@playwright/test";

test("font isolation is explicit, survives regeneration, and is disabled on old engines", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/font-editor.html");
  await expect(page.getByRole("switch", { name: "Изоляция шрифтов" })).toBeDisabled();
  await page.goto("/font-editor.html?supported");
  const toggle = page.getByRole("switch", { name: "Изоляция шрифтов" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByTestId("font-setting")).toHaveText("true");
  await page.getByRole("button", { name: "Новый отпечаток", exact: true }).click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText("Отдельный фиксированный набор", { exact: false })).toBeVisible();
  const box = await page.getByRole("main").boundingBox();
  expect(box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(errors).toEqual([]);
});
