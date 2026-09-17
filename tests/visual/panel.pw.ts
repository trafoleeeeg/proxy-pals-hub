import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { fixture } from "./mock-api";

declare global { interface Window { fixture: typeof fixture } }

async function calls(page: Page, method: string) {
  return page.evaluate((name) => window.fixture.calls.filter((call) => call.method === name).map((call) => call.data), method);
}
async function fit(page: Page, selector?: string) {
  const metrics = await page.locator(selector ?? "html").evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { scroll: element.scrollWidth, width: element.clientWidth, x: box.x, right: box.right, y: box.y, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  expect(metrics.scroll, "content must not overflow horizontally").toBeLessThanOrEqual(metrics.width + 1);
  if (selector) {
    expect(metrics.x).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.y).toBeGreaterThanOrEqual(0);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
  }
}
async function capture(page: Page, info: TestInfo, name: string) {
  await fit(page);
  await page.screenshot({ path: `tests/visual/artifacts/${info.project.name}-${name}.png`, fullPage: true, animations: "disabled" });
}
async function openProfiles(page: Page, scenario = "") {
  await page.goto(`/app${scenario ? `?scenario=${scenario}` : ""}`);
  await expect(page.getByRole("heading", { name: "Профили", exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Запустить Рабочий профиль", exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  (page as Page & { fixtureErrors: string[] }).fixtureErrors = errors;
});
test.afterEach(async ({ page }) => {
  expect((page as Page & { fixtureErrors: string[] }).fixtureErrors).toEqual([]);
});

test("bulk edit preserves hidden selection and sends only selected fields", async ({ page }, info) => {
  await openProfiles(page);
  await page.getByRole("button", { name: "Редактировать", exact: true }).click();
  await capture(page, info, "profiles");
  await page.getByRole("checkbox", { name: "Выбрать Рабочий профиль", exact: true }).check();
  await page.getByRole("checkbox", { name: "Выбрать Резервный профиль", exact: true }).check();
  await page.getByRole("textbox", { name: "Поиск профилей" }).fill("Рабочий");
  await expect(page.getByText("скрыто фильтром: 1", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: "Папка", exact: true }).check();
  await dialog.getByRole("textbox", { name: "Новая папка" }).fill("Архив");
  await dialog.getByRole("checkbox", { name: "Метки", exact: true }).check();
  await dialog.getByRole("textbox", { name: "Новые метки через запятую" }).fill("новая, новая, важное");
  await dialog.getByRole("checkbox", { name: "Заметки", exact: true }).check();
  await dialog.getByRole("textbox", { name: "Новые заметки" }).fill("Общая заметка");
  await dialog.getByRole("checkbox", { name: "Прокси", exact: true }).check();
  await dialog.getByRole("combobox", { name: "Новый прокси" }).click();
  await page.getByRole("option", { name: "Прокси Германия" }).click();
  await fit(page, '[role="dialog"]');
  await capture(page, info, "bulk-edit");
  await dialog.getByRole("button", { name: "Применить" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, "bulkUpdateProfiles")).toEqual([{ teamId: "team-a", ids: ["p1", "p2"], changes: { folder: "Архив", tags: ["новая", "важное"], notes: "Общая заметка", proxyId: "proxy-1" } }]);
});

test("folders can be cleared and deletion requires confirmation with recoverable errors", async ({ page }, info) => {
  await openProfiles(page);
  await page.getByRole("button", { name: "Редактировать", exact: true }).click();
  await page.getByRole("checkbox", { name: "Выбрать Рабочий профиль", exact: true }).check();
  await page.getByRole("button", { name: "В папку", exact: true }).click();
  await fit(page, '[role="dialog"]');
  await page.getByRole("button", { name: "Применить" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await calls(page, "bulkUpdateProfiles")).toEqual([{ teamId: "team-a", ids: ["p1"], changes: { folder: "" } }]);
  await page.getByRole("button", { name: "Без папки", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("checkbox", { name: "Выбрать видимые профили" }).check();
  await page.getByRole("button", { name: "Удалить выбранные профили", exact: true }).click();
  await fit(page, '[role="alertdialog"]');
  await capture(page, info, "delete");
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  expect(await calls(page, "bulkDeleteProfiles")).toEqual([]);
  await page.getByRole("button", { name: "Удалить выбранные профили", exact: true }).click();
  await page.evaluate(() => { window.fixture.failures = ["bulkDeleteProfiles"]; });
  await page.getByRole("button", { name: "Удалить 2", exact: true }).click();
  await expect(page.getByRole("alertdialog").getByRole("alert")).toBeVisible();
  await page.evaluate(() => { window.fixture.failures = []; });
  await page.getByRole("button", { name: "Удалить 2", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByText("По выбранным фильтрам профилей нет")).toBeVisible();
});

test("cookie import and JSON/Netscape downloads use the actual dialog", async ({ page }, info) => {
  await openProfiles(page);
  await page.getByRole("button", { name: "Редактировать", exact: true }).click();
  await page.getByRole("button", { name: /^Cookies Очень/ }).click();
  await fit(page, '[role="dialog"]');
  await capture(page, info, "cookies-long-name");
  const dialog = page.getByRole("dialog");
  const text = '[{"domain":".example.com","path":"/","name":"fixture","value":"mock-only","httpOnly":true,"secure":true}]';
  await dialog.getByLabel("Файл cookies").setInputFiles({ name: "cookies.json", mimeType: "application/json", buffer: Buffer.from(text) });
  await expect(dialog.getByLabel("Содержимое", { exact: true })).toHaveValue(text);
  await expect(dialog.getByRole("button", { name: "Импортировать" })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Импортировать" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Импортировано cookies: 1");
  await expect(dialog.getByLabel("Содержимое", { exact: true })).toHaveValue("");
  expect(await calls(page, "importProfileCookies")).toEqual([{ profileId: "p4", text }]);
  const jsonDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Выгрузить файл" }).click();
  const json = await jsonDownload;
  expect(JSON.parse(await readFile((await json.path())!, "utf8"))).toEqual(JSON.parse(text));
  await dialog.getByRole("combobox", { name: "Формат экспорта cookies" }).click();
  await page.getByRole("option", { name: "Netscape", exact: true }).click();
  const netscapeDownload = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Выгрузить файл" }).click();
  const netscape = await netscapeDownload;
  expect(await readFile((await netscape.path())!, "utf8")).toContain("#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tfixture\tmock-only");
});

test("profile editor validates runtime settings and omits an empty optional URL", async ({ page }, info) => {
  await openProfiles(page);
  await page.getByRole("button", { name: "Новый профиль", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Название", { exact: true }).fill("Новый рабочий");
  await dialog.getByLabel("Стартовый адрес", { exact: true }).fill("https://example.com");
  await dialog.getByLabel("Стартовый адрес", { exact: true }).fill("");
  await dialog.getByLabel("Часовой пояс", { exact: true }).fill("wrong/zone");
  await expect(dialog.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  await dialog.getByLabel("Часовой пояс", { exact: true }).fill("Europe/Berlin");
  await fit(page, '[role="dialog"]');
  await dialog.evaluate((element) => { element.scrollTop = 0; });
  await capture(page, info, "profile-editor");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = await calls(page, "saveProfile");
  expect(saved[0].fingerprint).not.toHaveProperty("startUrl");
});

test("team bulk assignment grants and revokes the selected profiles", async ({ page }, info) => {
  await openProfiles(page);
  await page.getByRole("link", { name: "Команда", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Команда", exact: true })).toBeVisible();
  await capture(page, info, "team-members");
  await page.getByRole("tab", { name: "Доступы", exact: true }).click();
  await page.getByRole("checkbox", { name: "Выбрать Рабочий профиль", exact: true }).check();
  await page.getByRole("checkbox", { name: "Выбрать Резервный профиль", exact: true }).check();
  await page.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  await page.getByRole("combobox", { name: "Сотрудник", exact: true }).click();
  await page.getByRole("option", { name: "staff@example.com", exact: true }).click();
  await fit(page, '[role="dialog"]');
  await capture(page, info, "team-access");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Доступ staff@example.com к Рабочий профиль", exact: true })).toBeChecked();
  await page.getByRole("checkbox", { name: "Выбрать Рабочий профиль", exact: true }).check();
  await page.getByRole("button", { name: "Изменить доступ", exact: true }).click();
  await page.getByRole("combobox", { name: "Сотрудник", exact: true }).click();
  await page.getByRole("option", { name: "staff@example.com", exact: true }).click();
  await page.getByRole("combobox", { name: "Действие с доступом", exact: true }).click();
  await page.getByRole("option", { name: "Отозвать доступ", exact: true }).click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await calls(page, "setProfilesAccess")).toEqual([
    { teamId: "team-a", profileIds: ["p1", "p2"], userId: "staff", granted: true },
    { teamId: "team-a", profileIds: ["p1"], userId: "staff", granted: false },
  ]);
});

test("lifecycle stays global across workspace changes and recovers offline closures", async ({ page }, info) => {
  await openProfiles(page);
  await expect(page.getByRole("button", { name: "Запустить Рабочий профиль", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Запустить Рабочий профиль", exact: true }).click();
  await expect(page.getByRole("button", { name: "Закрыть Рабочий профиль", exact: true })).toBeEnabled();
  await page.getByRole("combobox", { name: "Рабочая команда", exact: true }).click();
  await page.getByRole("option", { name: "Вторая команда", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Выбрать Профиль второй команды", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Приложение", exact: true }).click();
  await expect(page.getByText("Открыто профилей: 1", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixture.closedSubscriptions())).toBe(1);
  await page.evaluate(() => { window.fixture.failures = ["closeProfile"]; window.fixture.emitClosed("p1"); });
  await expect(page.getByText("Ожидают сохранения: 1", { exact: true })).toBeVisible();
  await capture(page, info, "global-sync-error");
  await page.evaluate(() => { window.fixture.failures = []; });
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByText("Ожидают сохранения: 1", { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.fixture.outbox.length)).toBe(0);
  expect((await calls(page, "closeProfile")).every((data) => data.profileId === "p1" && data.lockToken === "lease-p1")).toBe(true);
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
  })).toBe(false);
});

test("update status persists through navigation and installation waits for profile closure", async ({ page }, info) => {
  await openProfiles(page);
  await page.getByRole("button", { name: "Запустить Рабочий профиль", exact: true }).click();
  await expect(page.getByRole("button", { name: "Закрыть Рабочий профиль", exact: true })).toBeEnabled();
  await page.evaluate(() => window.fixture.emitUpdate({ state: "downloaded", version: "0.5.0" }));
  await page.getByRole("button", { name: "Установить и перезапустить", exact: true }).click();
  await expect(page.getByText("Закройте профили и завершите синхронизацию перед установкой обновления.", { exact: true })).toBeVisible();
  expect(await calls(page, "installUpdate")).toEqual([]);
  await page.getByRole("button", { name: "Закрыть Рабочий профиль", exact: true }).click();
  await page.getByRole("link", { name: "Приложение", exact: true }).click();
  await expect(page.getByText("Открыто профилей: 0", { exact: true })).toBeVisible();
  await page.evaluate(() => window.fixture.emitUpdate({ state: "downloading", percent: 67 }));
  await capture(page, info, "update-progress");
  await page.evaluate(() => window.fixture.emitUpdate({ state: "error", error: "mock server internal secret" }));
  await expect(page.getByText("mock server internal secret")).toHaveCount(0);
  await page.getByRole("button", { name: "Проверить обновления", exact: true }).click();
  await expect(page.getByRole("button", { name: "Скачать", exact: true }).last()).toBeVisible();
  await page.evaluate(() => window.fixture.emitUpdate({ state: "downloaded", version: "0.5.0" }));
  await page.getByRole("button", { name: "Установить и перезапустить", exact: true }).last().click();
  await expect.poll(() => calls(page, "installUpdate")).toEqual([{}]);
});

test("locks block destructive edits and cookie replacement while export stays available", async ({ page }, info) => {
  await openProfiles(page, "locked");
  await page.getByRole("button", { name: "Редактировать", exact: true }).click();
  await expect(page.getByRole("button", { name: "Изменить Рабочий профиль", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Выбрать Рабочий профиль", exact: true }).check();
  await page.getByRole("button", { name: "Удалить выбранные профили", exact: true }).click();
  await expect(page.getByRole("button", { name: "Удалить 1", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  await page.getByRole("button", { name: "Cookies Рабочий профиль", exact: true }).click();
  await expect(page.getByRole("button", { name: "Импортировать", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Выгрузить файл", exact: true })).toBeEnabled();
  await fit(page, '[role="dialog"]');
  await capture(page, info, "cookies-locked");
});

test("member and web-only views do not expose unavailable owner actions", async ({ page }, info) => {
  await page.goto("/app?scenario=member");
  await expect(page.getByRole("heading", { name: /Профили/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Новый профиль", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Cookies / })).toHaveCount(0);
  await capture(page, info, "member");
  await page.goto("/app?scenario=web");
  await expect(page.getByRole("button", { name: "Запустить Рабочий профиль", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Приложение", exact: true }).click();
  await expect(page.getByRole("link", { name: "Скачать установщик из последнего релиза", exact: true })).toBeVisible();
});

test("bulk fingerprint changes and creation validate before sending", async ({ page }, info) => {
  await openProfiles(page);
  await page.getByRole("button", { name: "Редактировать", exact: true }).click();
  await page.getByRole("checkbox", { name: "Выбрать Рабочий профиль", exact: true }).check();
  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: "Отпечаток", exact: true }).check();
  await dialog.getByLabel("Часовой пояс", { exact: true }).fill("Europe/Berlin");
  await fit(page, '[role="dialog"]');
  await capture(page, info, "bulk-fingerprint");
  await dialog.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const updated = await calls(page, "bulkUpdateProfiles");
  expect(Object.keys(updated[0].changes)).toEqual(["fingerprint"]);
  expect(updated[0].changes.fingerprint.timezone).toBe("Europe/Berlin");
  expect(updated[0].changes.fingerprint).not.toHaveProperty("startUrl");
  await page.getByRole("button", { name: "Создать пачкой", exact: true }).click();
  await dialog.getByLabel("Количество, 1–200", { exact: true }).fill("201");
  await expect(dialog.getByRole("button", { name: "Создать", exact: true })).toBeDisabled();
  await dialog.getByLabel("Количество, 1–200", { exact: true }).fill("2");
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await calls(page, "bulkCreateProfiles"))[0].fingerprints).toHaveLength(2);
});

test("more than 200 selected profiles cannot submit a destructive bulk request", async ({ page }) => {
  await openProfiles(page);
  await page.getByRole("button", { name: "Редактировать", exact: true }).click();
  await page.evaluate(() => {
    const source = window.fixture.profiles[0]!;
    window.fixture.profiles = Array.from({ length: 201 }, (_, i) => ({ ...source, id: `many-${i}`, name: `Профиль ${i}` }));
  });
  await page.getByRole("button", { name: "Обновить список", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(201);
  await page.getByRole("checkbox", { name: "Выбрать видимые профили", exact: true }).check();
  await page.getByRole("button", { name: "Удалить выбранные профили", exact: true }).click();
  await expect(page.getByRole("alertdialog").getByRole("alert")).toContainText("до 200 профилей");
  await expect(page.getByRole("button", { name: "Удалить 201", exact: true })).toBeDisabled();
  expect(await calls(page, "bulkDeleteProfiles")).toEqual([]);
});
