import { createApp } from "../server.js";
import { fileURLToPath } from "node:url";
import { forecastMethods } from "../validation.js";

// Synthetic data is confined to this test server. Production always uses Kronos.
const candle = (time, close) => ({
  time,
  open: close - 1,
  high: close + 2,
  low: close - 2,
  close,
  volume: 1000,
});
const fixtureEvaluation = (request) => {
  const fold = (dates) => ({
    origin: "2025-06-25", start: dates[0], end: dates.at(-1), seed: 42,
    prediction: dates.map((day, i) => candle(day, 101 + i)),
    actual: dates.map((day, i) => candle(day, 100 + i)),
    baseline: dates.map(day => ({ time: day, open: 99, high: 99, low: 99, close: 99, volume: 1000 })),
    metrics: { objectiveMAE: 1, baselineMAE: 2, closeMAE: 1 },
  });
  const folds = [fold(["2025-06-26", "2025-06-27", "2025-06-30"]), fold(["2025-07-01", "2025-07-02", "2025-07-03"])];
  return {
    method: "chronological-selection-then-audit", objective: request.objective,
    selectedCandidate: "paper-40", tuningWindows: request.validationWindows, auditWindows: 2,
    candidates: forecastMethods.candidates.map((settings, i) => ({ settings, status: "complete", metrics: { objectiveMAE: i + 1 }, folds: [] })),
    audit: { metrics: { objectiveMAE: 1, baselineMAE: 2, skillPercent: 50 }, folds },
    baselineFallback: false, history: [candle("2025-06-25", 99)],
    limitations: "Retrospective audit on two windows, not proof of future accuracy.",
  };
};
const worker = {
  async run(id, request, progress) {
    progress("Loading test fixture…");
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (request.ticker === "INVALID")
      throw new Error("Could not load INVALID. Check the ticker/date range.");
    return {
      ticker: request.ticker,
      name: "Test asset",
      currency: "USD",
      interval: "1d",
      calendar: "NYSE",
      model: "Kronos-small",
      seed: request.seed,
      generatedAt: new Date().toISOString(),
      sampling: { temperature: request.temperature, topP: request.topP, sampleCount: request.sampleCount },
      methodology: { method: request.method, settings: { lookback: request.lookback }, forecastMethod: "kronos", volumeIncluded: true },
      evaluation: request.method === "validated" ? fixtureEvaluation(request) : null,
      inputHistory: [candle("2025-07-03", 103)],
      source: "Test fixture",
      context: {
        used: 3,
        available: 3,
        start: "2025-07-01",
        end: "2025-07-03",
      },
      history: [
        candle("2025-07-01", 100),
        candle("2025-07-02", 102),
        candle("2025-07-03", 103),
      ],
      forecast: [
        candle("2025-07-07", 104),
        candle("2025-07-08", 105),
        candle("2025-07-09", 106),
      ],
      summary: { lastClose: 103, forecastClose: 106, changePercent: 2.9126 },
      normalizedCandles: 0,
    };
  },
  close() {},
};
const { app, close } = createApp({
  ...(process.env.KRONOS_LIVE === "1" ? {} : { worker }),
  outputDir: fileURLToPath(
    new URL("../test-results/forecast-outputs/", import.meta.url),
  ),
});
const server = app.listen(3100, "127.0.0.1");
process.on("SIGTERM", () => {
  close();
  server.closeAllConnections();
  server.close();
});
