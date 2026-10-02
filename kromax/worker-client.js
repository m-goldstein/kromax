import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// One persistent worker keeps model weights in memory. Jobs are serialized by the API.
export class WorkerClient {
  constructor({
    timeoutMs = Number(process.env.JOB_TIMEOUT_MS) || 900000,
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.pending = null;
  }

  start() {
    if (this.child) return;
    const localPython = `${root}.venv/bin/python`;
    const python =
      process.env.PYTHON_BIN ||
      (existsSync(localPython) ? localPython : "python3");
    const child = spawn(python, ["-u", `${root}python/worker.py`], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const job = this.pending;
      if (!job || message.id !== job.id) return;
      if (message.type === "progress") job.onProgress(message.message);
      if (message.type === "result") this.finish(null, message.result);
      if (message.type === "error") this.finish(new Error(message.message));
    });
    child.stderr.on("data", (data) => process.stderr.write(data));
    child.stdin.on("error", (error) =>
      this.finish(new Error(`Python worker input failed: ${error.message}`)),
    );
    child.on("error", (error) => {
      if (this.child === child) this.child = null;
      this.finish(
        new Error(
          `Cannot start Python worker. Install python/requirements.txt or set PYTHON_BIN. ${error.message}`,
        ),
      );
    });
    child.on("exit", () => {
      lines.close();
      if (this.child === child) {
        this.child = null;
        this.finish(
          new Error(
            "Python worker exited. Check Python dependencies and server logs.",
          ),
        );
      }
    });
  }

  run(id, request, onProgress) {
    if (this.pending) return Promise.reject(new Error("Worker is busy."));
    this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const child = this.child;
        this.child = null;
        child?.kill("SIGKILL");
        this.finish(
          new Error("Forecast timed out. Try Kronos-mini or fewer candles."),
        );
      }, this.timeoutMs);
      this.pending = { id, resolve, reject, onProgress, timer };
      this.child.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
    });
  }

  finish(error, result) {
    const job = this.pending;
    if (!job) return;
    this.pending = null;
    clearTimeout(job.timer);
    if (error) job.reject(error);
    else job.resolve(result);
  }

  close() {
    const child = this.child;
    this.child = null;
    child?.kill("SIGTERM");
    this.finish(new Error("Server is shutting down."));
  }
}
