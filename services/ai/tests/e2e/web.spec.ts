import { expect, test } from "@playwright/test";

const APP_BASE_URL = process.env.APP_BASE_URL;

test.skip(
  !APP_BASE_URL,
  "set APP_BASE_URL to the running SentinelZero web app to enable browser smoke tests",
);

test("web app renders without uncaught page errors", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  const response = await page.goto(APP_BASE_URL!, { waitUntil: "domcontentloaded" });
  expect(response?.status() ?? 200).toBeLessThan(400);

  await expect(page.locator("body")).toBeVisible();
  const text = (await page.locator("body").innerText()).trim();
  expect(text.length).toBeGreaterThan(0);

  const panelSelector = process.env.AI_PANEL_SELECTOR;
  if (panelSelector) {
    await expect(page.locator(panelSelector)).toBeVisible();
  }

  await page.waitForTimeout(1_000);
  expect(pageErrors).toEqual([]);
});
