import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("submits ticker and range, renders real chart and table, exports CSV", async ({
  page,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await expect(page.getByText("API connected")).toBeVisible();
  await page.locator("#ticker").fill("AAPL");
  await page.locator("#start").fill("2025-01-01");
  await page.locator("#end").fill("2025-07-03");
  await page.locator("#horizon").fill("3");
  const saveOutput = page.getByRole("checkbox", { name: "Save forecast JSON" });
  await expect(saveOutput).not.toBeChecked();
  await saveOutput.check();
  const submission = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/forecasts") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Generate forecast" }).click();
  const accepted = await submission;
  expect(accepted.status()).toBe(202);
  expect(accepted.request().postDataJSON()).toMatchObject({
    ticker: "AAPL",
    start: "2025-01-01",
    end: "2025-07-03",
    horizon: 3,
    saveOutput: true,
  });
  await expect(page.locator("tbody tr")).toHaveCount(3, {
    timeout: process.env.KRONOS_LIVE === "1" ? 890000 : 10000,
  });
  await expect(page.locator("tbody tr").first()).toContainText("2025-07-07");
  await expect(page.locator("candle-chart canvas").first()).toBeVisible();
  await expect(page.locator(".save-output-status")).toContainText(
    "Forecast JSON saved to outputs/",
  );
  const outputPath = await page
    .locator(".save-output-status code")
    .textContent();
  const filename = outputPath.slice("outputs/".length);
  const record = JSON.parse(
    await readFile(
      new URL(`../test-results/forecast-outputs/${filename}`, import.meta.url),
      "utf8",
    ),
  );
  expect(record.assets[0].ticker).toBe("AAPL");
  expect(record.assets[0].candles).toHaveLength(3);
  expect(record.assets[0].candles[0].date).toBe("2025-07-07");
  expect(typeof record.assets[0].candles[0].close).toBe("number");
  expect(record.request.saveOutput).toBe(true);
  await expect(
    page.getByRole("button", { name: "Generate forecast" }),
  ).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("AAPL-kronos-forecast.csv");
  const csv = await readFile(await download.path(), "utf8");
  expect(csv).toContain("forecast,2025-07-07,");
  expect(csv).toContain("history,");
  await page.screenshot({
    path: testInfo.outputPath("forecast-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("forecast-mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("shows date validation and server errors with retry available", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#start").fill("2025-07-03");
  await page.locator("#end").fill("2025-01-01");
  await page.getByRole("button", { name: "Generate forecast" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Start date must be on or before end date.",
  );
  await page.locator("#start").fill("2025-01-01");
  await page.locator("#end").fill("2025-07-03");
  await page
    .locator("#ticker")
    .fill(process.env.KRONOS_LIVE === "1" ? "ZZZZINVALID999" : "INVALID");
  await page.getByRole("button", { name: "Generate forecast" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load", {
    timeout: 90000,
  });
  await expect(
    page.getByRole("button", { name: "Generate forecast" }),
  ).toBeEnabled();
});
