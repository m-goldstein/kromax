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
  await expect(page.locator(".forecast-table tbody tr")).toHaveCount(3, {
    timeout: process.env.KRONOS_LIVE === "1" ? 890000 : 10000,
  });
  await expect(page.locator(".forecast-table tbody tr").first()).toContainText("2025-07-07");
  await expect(page.locator(".methodology-panel")).toContainText("Paper preset");
  await expect(page.locator(".methodology-panel")).toContainText("40 context candles");
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
  expect(record.assets[0].sampling).toMatchObject({ temperature: .6, topP: .9, sampleCount: 10 });
  expect(record.assets[0].inputHistory[0]).toHaveProperty("date");
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

test("validates on the asset, displays audit scores and saves the complete evidence", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.locator("#method").selectOption({ label: "Validate on this asset" });
  await expect(page.locator("#validation-windows")).toHaveValue("3");
  await page.locator("#start").fill("2024-07-01");
  await page.locator("#end").fill("2025-07-03");
  await page.locator("#horizon").fill("3");
  await page.locator("#baseline-fallback").check();
  await page.locator("#save-output").check();
  await page.getByRole("button", { name: "Generate forecast" }).click();
  await expect(page.getByRole("heading", { name: "Historical accuracy check" })).toBeVisible({ timeout: process.env.KRONOS_LIVE === "1" ? 890000 : 10000 });
  await expect(page.locator(".candidate-table tbody tr")).toHaveCount(4);
  await expect(page.locator(".selected-candidate")).toHaveCount(1);
  await expect(page.locator(".evaluation-panel")).toContainText("3 selection + 2 audit windows");
  await expect(page.locator(".forecast-table tbody tr")).toHaveCount(3);
  await expect(page.locator(".save-output-status")).toBeVisible();
  const filename = (await page.locator(".save-output-status code").textContent()).slice("outputs/".length);
  const record = JSON.parse(await readFile(new URL(`../test-results/forecast-outputs/${filename}`, import.meta.url), "utf8"));
  const asset = record.assets[0];
  expect(record.request.method).toBe("validated");
  expect(asset.evaluation.audit.folds).toHaveLength(2);
  expect(asset.evaluation.candidates).toHaveLength(4);
  expect(asset.evaluation.audit.folds[0].prediction[0]).toHaveProperty("date");
  expect(asset.evaluation.audit.folds[0].actual[0]).toHaveProperty("date");
  expect(asset.evaluation.audit.folds[0].baseline[0]).toHaveProperty("date");
  expect(asset.evaluation.audit.folds[0].prediction[0]).not.toHaveProperty("time");
  expect(asset.evaluation.audit.folds[0].origin < asset.evaluation.audit.folds[0].start).toBe(true);
  if (asset.evaluation.baselineFallback) {
    await expect(page.locator(".baseline-notice")).toContainText("Baseline used");
    expect(asset.candles.every(c => c.close === asset.summary.lastClose && c.high === c.low)).toBe(true);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    expect((await downloadPromise).suggestedFilename()).toBe("AAPL-persistence-forecast.csv");
  }
  if (process.env.KRONOS_LIVE === "1") {
    for (const candidate of asset.evaluation.candidates) {
      expect(candidate.status).toBe("complete");
      expect(candidate.folds).toHaveLength(3);
      expect(candidate.folds.at(-1).end < asset.evaluation.audit.folds[0].start).toBe(true);
    }
  }
  await page.screenshot({ path: testInfo.outputPath("validation-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("validation-mobile.png"), fullPage: true });
});

test("custom controls submit their settings and switching modes resets sampling", async ({ page }) => {
  await page.goto("/");
  await page.locator("#method").selectOption({ label: "Custom" });
  await page.locator("#lookback").fill("60");
  await page.locator("#temperature").fill("0.8");
  await page.locator("#top-p").fill("0.95");
  await page.locator("#sample-count").fill("2");
  await page.locator("#start").fill("2025-01-01");
  await page.locator("#end").fill("2025-07-03");
  await page.locator("#horizon").fill("3");
  await page.getByText("Volume & reproducibility", { exact: true }).click();
  await page.locator("#volume-mode").selectOption("exclude");
  await page.locator("#seed-mode").selectOption("manual");
  await page.locator("#seed").fill("123");
  const submission = page.waitForResponse(response => response.url().endsWith("/api/forecasts") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate forecast" }).click();
  const accepted = await submission;
  expect(accepted.status()).toBe(202);
  expect(accepted.request().postDataJSON()).toMatchObject({ method: "custom", lookback: 60, temperature: .8, topP: .95, sampleCount: 2, seed: 123, seedMode: "manual", volumeMode: "exclude" });
  await expect(page.locator(".forecast-table tbody tr")).toHaveCount(3, { timeout: process.env.KRONOS_LIVE === "1" ? 890000 : 10000 });
  await page.locator("#method").selectOption({ label: "Paper preset" });
  await expect(page.locator("#lookback")).toHaveCount(0);
  await expect(page.locator("#horizon")).toHaveValue("12");
  await expect(page.locator("#seed-mode")).toHaveValue("reproducible");
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
