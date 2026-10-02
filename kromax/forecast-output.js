import { randomUUID } from "node:crypto";
import { mkdir, writeFile, link, rm } from "node:fs/promises";
import { join } from "node:path";

const datedCandles = (candles) =>
  candles.map(({ time, ...prices }) => ({ date: time, ...prices }));

const datedEvaluation = (evaluation) => {
  if (!evaluation) return evaluation;
  const datedRun = (run) => ({
    ...run,
    ...(run.folds ? { folds: run.folds.map((fold) => ({
      ...fold,
      prediction: datedCandles(fold.prediction),
      actual: datedCandles(fold.actual),
      baseline: datedCandles(fold.baseline),
    })) } : {}),
  });
  return {
    ...evaluation,
    history: datedCandles(evaluation.history),
    candidates: evaluation.candidates.map(datedRun),
    audit: datedRun(evaluation.audit),
  };
};

export async function saveForecast(job, outputDir) {
  const savedAt = new Date().toISOString();
  const { history, forecast, inputHistory, evaluation, ...metadata } = job.result;
  const record = {
    schemaVersion: 1,
    forecastId: job.id,
    requestedAt: job.createdAt,
    generatedAt: job.result.generatedAt,
    savedAt,
    request: job.request,
    assets: [
      {
        ...metadata,
        ...(inputHistory ? { inputHistory: datedCandles(inputHistory) } : {}),
        ...(evaluation ? { evaluation: datedEvaluation(evaluation) } : {}),
        history: datedCandles(history),
        candles: datedCandles(forecast),
      },
    ],
  };
  const ticker = job.request.ticker.replace(/[^A-Z0-9_-]/g, "_");
  const filename = `${savedAt.replace(/[:.]/g, "-")}_${ticker}_${job.id}.json`;
  const target = join(outputDir, filename);
  const temporary = join(outputDir, `.${randomUUID()}.tmp`);
  await mkdir(outputDir, { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    // Publish only the complete file, and never replace an existing paper trail.
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return { status: "saved", path: `outputs/${filename}`, savedAt };
}
