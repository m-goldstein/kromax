import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validateRequest, forecastMethods } from "./validation.js";
import { WorkerClient } from "./worker-client.js";
import { saveForecast } from "./forecast-output.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const terminal = (job) => ["complete", "failed"].includes(job.status);

export function createApp({
  worker = new WorkerClient(),
  maxJobs = 100,
  maxQueue = 5,
  outputDir = resolve(root, "../outputs"),
} = {}) {
  const app = express();
  const jobs = new Map();
  const queue = [];
  let active = false;
  let closing = false;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
    next();
  });
  app.use(express.json({ limit: "8kb" }));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  async function pump() {
    if (closing || active || !queue.length) return;
    active = true;
    const job = queue.shift();
    job.status = "running";
    job.message = "Starting forecast worker…";
    try {
      job.result = await worker.run(job.id, job.request, (message) => {
        job.message = message;
      });
      if (job.request.saveOutput) {
        job.message = "Saving forecast paper trail…";
        try {
          job.output = await saveForecast(job, outputDir);
        } catch (error) {
          console.error("Forecast output could not be saved:", error);
          job.output = {
            status: "failed",
            error:
              "Forecast completed, but its JSON paper trail could not be saved. Check the outputs directory permissions and available disk space. This run has not been archived.",
          };
        }
      }
      job.status = "complete";
      job.message = "Forecast complete";
    } catch (error) {
      job.status = "failed";
      job.error = error.message;
    } finally {
      job.finishedAt = new Date().toISOString();
      active = false;
      void pump();
    }
  }

  app.get("/api/health", (req, res) =>
    res.json({ status: "ok", busy: active, queued: queue.length }),
  );
  app.get("/api/methods", (req, res) => res.json(forecastMethods));
  app.post("/api/forecasts", (req, res) => {
    let request;
    try {
      request = validateRequest(req.body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (queue.length >= maxQueue)
      return res
        .status(429)
        .json({ error: "Forecast queue is full. Please try again shortly." });
    for (const [id, job] of jobs) {
      if (
        terminal(job) &&
        (jobs.size >= maxJobs ||
          Date.now() - Date.parse(job.finishedAt) > 3600000)
      )
        jobs.delete(id);
    }
    const job = {
      id: randomUUID(),
      status: "queued",
      message: "Waiting for the model…",
      request,
      createdAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);
    queue.push(job);
    res.status(202).json({ id: job.id, status: job.status });
    void pump();
  });
  app.get("/api/forecasts/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job)
      return res.status(404).json({
        error: "Forecast not found or expired. Submit a new analysis.",
      });
    res.json(job);
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "API route not found." }),
  );
  app.get("/vendor/angular.js", (req, res) =>
    res.sendFile(`${root}node_modules/angular/angular.min.js`),
  );
  app.get("/vendor/charts.js", (req, res) =>
    res.sendFile(
      `${root}node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js`,
    ),
  );
  app.use(express.static(`${root}public`));
  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({
      error:
        error.type === "entity.parse.failed"
          ? "Invalid JSON request."
          : "Request could not be processed.",
    });
  });
  return {
    app,
    close: () => {
      closing = true;
      worker.close();
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { app, close } = createApp();
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, host, () =>
    console.log(`Kromax: http://${host}:${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      close();
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
}
