import { createApp } from "../server.js";

// Synthetic data is confined to this test server. Production always uses Kronos.
const candle = (time, close) => ({
  time,
  open: close - 1,
  high: close + 2,
  low: close - 2,
  close,
  volume: 1000,
});
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
const { app, close } = createApp(
  process.env.KRONOS_LIVE === "1" ? {} : { worker },
);
const server = app.listen(3100, "127.0.0.1");
process.on("SIGTERM", () => {
  close();
  server.closeAllConnections();
  server.close();
});
