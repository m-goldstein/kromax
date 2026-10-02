import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
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
  ]) {
    const response = await api.post(request);
    assert.equal(response.status, 400, JSON.stringify(request));
    assert.ok((await response.json()).error);
  }
  assert.equal(calls, 0);
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
