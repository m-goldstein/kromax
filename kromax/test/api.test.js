import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.js";
import { WorkerClient } from "../worker-client.js";

async function serve(t, worker, options = {}) {
  const { app, close } = createApp({ worker, ...options });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    close();
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (path) => fetch(base + path),
    post: (body) =>
      fetch(base + "/api/forecasts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

test("rejects invalid tickers, dates, horizons and models without running inference", async (t) => {
  let calls = 0;
  const api = await serve(t, {
    run() {
      calls++;
    },
    close() {},
  });
  for (const request of [
    null,
    [],
    {},
    { ticker: "$(whoami)" },
    { ticker: "AAPL", start: "2025-02-30" },
    { ticker: "AAPL", start: "2025-05-01", end: "2025-01-01" },
    { ticker: "AAPL", horizon: 61 },
    { ticker: "AAPL", horizon: 1.5 },
    { ticker: "AAPL", model: "../../file" },
    { ticker: "AAPL", seed: -1 },
    { ticker: "AAPL", saveOutput: "true" },
    { ticker: "AAPL", saveOutput: null },
    { ticker: "AAPL", method: "magic" },
    { ticker: "AAPL", method: "custom", lookback: 513 },
    { ticker: "AAPL", method: "custom", sampleCount: 0 },
    { ticker: "AAPL", method: "custom", temperature: 0 },
    { ticker: "AAPL", method: "custom", topP: 1.1 },
    { ticker: "AAPL", method: "validated", horizon: 21 },
    { ticker: "AAPL", method: "validated", validationWindows: 2 },
    { ticker: "AAPL", method: "validated", seedMode: "fresh" },
    { ticker: "AAPL", objective: "profit" },
    { ticker: "AAPL", volumeMode: "sometimes" },
    { ticker: "AAPL", fallbackToBaseline: "true" },
  ]) {
    const response = await api.post(request);
    assert.equal(response.status, 400, JSON.stringify(request));
    assert.ok((await response.json()).error);
  }
  assert.equal(calls, 0);
});

test("preset values reach the worker; custom and reproducibility controls are enforced", async (t) => {
  const requests = [];
  const api = await serve(t, {
    async run(id, request) { requests.push(request); return fixtureResult(request.ticker); },
    close() {},
  });
  const catalog = await (await api.get("/api/methods")).json();
  assert.equal(catalog.methods.length, 3);
  assert.equal(catalog.candidates.length, 4);
  await completedJob(api, { ticker: "AAPL", temperature: 1.4, sampleCount: 1, lookback: 400 });
  assert.equal(requests[0].temperature, 0.6);
  assert.equal(requests[0].sampleCount, 10);
  assert.equal(requests[0].lookback, 40);
  assert.equal(requests[0].horizon, 12);
  assert.equal(requests[0].seed, 42);
  assert.equal(requests[0].methodologyVersion, catalog.version);
  await completedJob(api, { ticker: "AAPL", method: "custom", lookback: 120, temperature: .8, topP: .95, sampleCount: 5, seedMode: "manual", seed: 19 });
  assert.equal(requests[1].lookback, 120);
  assert.equal(requests[1].temperature, .8);
  assert.equal(requests[1].topP, .95);
  assert.equal(requests[1].sampleCount, 5);
  assert.equal(requests[1].seed, 19);
  await completedJob(api, { ticker: "AAPL", seed: 123 });
  assert.equal(requests[2].seed, 123, "legacy API seed remains explicit manual seeding");
  await completedJob(api, { ticker: "AAPL", method: "validated", seed: 123 });
  assert.equal(requests[3].seed, 42, "validation cannot search manual seeds");
  await completedJob(api, { ticker: "AAPL", seedMode: "fresh" });
  assert.ok(Number.isInteger(requests[4].seed) && requests[4].seed >= 0 && requests[4].seed <= 2147483647);
});

async function outputDirectory(t) {
  const dir = await mkdtemp(join(tmpdir(), "kromax-output-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function completedJob(api, request) {
  const response = await api.post(request);
  assert.equal(response.status, 202);
  const { id } = await response.json();
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await (await api.get(`/api/forecasts/${id}`)).json();
    if (["complete", "failed"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Job did not finish");
}

const fixtureResult = (ticker) => ({
  ticker,
  currency: "USD",
  interval: "1d",
  calendar: "NYSE",
  generatedAt: "2026-01-02T22:00:00.000Z",
  model: "Kronos-small",
  seed: 42,
  source: "Test fixture",
  adjusted: true,
  sampling: { temperature: 1, topP: 0.9, sampleCount: 1 },
  context: { used: 1, end: "2026-01-02" },
  history: [
    {
      time: "2026-01-02",
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 123,
    },
  ],
  forecast: [
    {
      time: "2026-01-05",
      open: 101.0123456789,
      high: 104,
      low: 100,
      close: 103,
      volume: 456,
    },
  ],
});
const outputWorker = {
  async run(id, request) {
    return fixtureResult(request.ticker);
  },
  close() {},
};

test("output is opt-in and does not create files when unchecked or omitted", async (t) => {
  const outputDir = await outputDirectory(t);
  const api = await serve(t, outputWorker, { outputDir });
  for (const request of [
    { ticker: "AAPL" },
    { ticker: "AAPL", saveOutput: false },
  ]) {
    const job = await completedJob(api, request);
    assert.equal(job.status, "complete");
    assert.equal(job.output, undefined);
  }
  assert.deepEqual(await readdir(outputDir), []);
});

test("persists independent JSON paper trails for repeated runs and different assets", async (t) => {
  const outputDir = await outputDirectory(t);
  const api = await serve(t, outputWorker, { outputDir });
  const filenames = [];
  for (const ticker of ["AAPL", "AAPL", "BTC-USD"]) {
    const job = await completedJob(api, { ticker, saveOutput: true });
    assert.equal(job.status, "complete");
    assert.equal(job.output.status, "saved");
    const filename = job.output.path.slice("outputs/".length);
    filenames.push(filename);
    const record = JSON.parse(
      await readFile(join(outputDir, filename), "utf8"),
    );
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.forecastId, job.id);
    assert.equal(record.requestedAt, job.createdAt);
    assert.equal(record.generatedAt, fixtureResult(ticker).generatedAt);
    assert.equal(record.savedAt, job.output.savedAt);
    assert.equal(record.request.seed, 42);
    assert.equal(record.assets[0].ticker, ticker);
    assert.equal(record.assets[0].adjusted, true);
    assert.deepEqual(record.assets[0].sampling, fixtureResult(ticker).sampling);
    assert.deepEqual(record.assets[0].candles, [
      {
        date: "2026-01-05",
        open: 101.0123456789,
        high: 104,
        low: 100,
        close: 103,
        volume: 456,
      },
    ]);
    assert.equal(record.assets[0].history[0].date, "2026-01-02");
  }
  assert.equal(new Set(filenames).size, 3);
  assert.deepEqual((await readdir(outputDir)).sort(), filenames.sort());
  // A new API instance does not remove archived files.
  await serve(t, outputWorker, { outputDir });
  assert.deepEqual((await readdir(outputDir)).sort(), filenames);
});

test("save failure is explicit while the successful forecast remains available", async (t) => {
  const dir = await outputDirectory(t);
  const outputDir = join(dir, "not-a-directory");
  await writeFile(outputDir, "blocked");
  const api = await serve(t, outputWorker, { outputDir });
  const job = await completedJob(api, { ticker: "AAPL", saveOutput: true });
  assert.equal(job.status, "complete");
  assert.equal(job.output.status, "failed");
  assert.match(job.output.error, /has not been archived/);
  assert.equal(job.result.forecast[0].close, 103);
  assert.equal(await readFile(outputDir, "utf8"), "blocked");
});

test("failed inference creates no paper trail", async (t) => {
  const outputDir = await outputDirectory(t);
  const api = await serve(
    t,
    {
      async run() {
        throw new Error("Provider unavailable");
      },
      close() {},
    },
    { outputDir },
  );
  const job = await completedJob(api, { ticker: "AAPL", saveOutput: true });
  assert.equal(job.status, "failed");
  assert.equal(job.output, undefined);
  assert.deepEqual(await readdir(outputDir), []);
});

test("serializes jobs, reports progress/results, handles failure and queue capacity", async (t) => {
  const pending = [];
  const worker = {
    run(id, request, progress) {
      progress("Loading test model");
      return new Promise((resolve, reject) =>
        pending.push({ id, request, resolve, reject }),
      );
    },
    close() {},
  };
  const api = await serve(t, worker, { maxQueue: 1 });
  const first = await (await api.post({ ticker: " aapl ", horizon: 3 })).json();
  assert.equal(pending[0].request.ticker, "AAPL");
  const running = await (await api.get(`/api/forecasts/${first.id}`)).json();
  assert.equal(running.status, "running");
  assert.equal(running.message, "Loading test model");
  const second = await (await api.post({ ticker: "SPY" })).json();
  assert.equal(pending.length, 1);
  assert.equal((await api.post({ ticker: "NVDA" })).status, 429);
  pending[0].resolve({ ticker: "AAPL", forecast: [{ close: 123 }] });
  await new Promise((resolve) => setImmediate(resolve));
  const complete = await (await api.get(`/api/forecasts/${first.id}`)).json();
  assert.equal(complete.status, "complete");
  assert.equal(complete.result.forecast[0].close, 123);
  assert.equal(pending.length, 2);
  pending[1].reject(new Error("Provider unavailable"));
  await new Promise((resolve) => setImmediate(resolve));
  const failed = await (await api.get(`/api/forecasts/${second.id}`)).json();
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "Provider unavailable");
  assert.equal((await api.get("/api/forecasts/missing")).status, 404);
});

test("serves UI and local vendor assets with security headers", async (t) => {
  const api = await serve(t, { close() {} });
  for (const path of [
    "/",
    "/app.js",
    "/styles.css",
    "/research.html",
    "/vendor/angular.js",
    "/vendor/charts.js",
  ]) {
    const response = await api.get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok((await response.text()).length > 100);
  }
});

test("missing Python produces an actionable job error", async (t) => {
  const previous = process.env.PYTHON_BIN;
  process.env.PYTHON_BIN = "/nonexistent/kronos-python";
  const worker = new WorkerClient();
  t.after(() => {
    worker.close();
    if (previous === undefined) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = previous;
  });
  await assert.rejects(
    worker.run("test", { ticker: "AAPL" }, () => {}),
    /Cannot start Python worker|worker input failed/,
  );
});
