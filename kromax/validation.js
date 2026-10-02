import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";

export const forecastMethods = JSON.parse(readFileSync(new URL("./forecast-methods.json", import.meta.url), "utf8"));

export function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Provide a JSON object.");
  const ticker =
    typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
  if (!/^[A-Z0-9^][A-Z0-9.^=\-]{0,19}$/.test(ticker))
    throw new Error("Enter a valid ticker, such as AAPL, SPY, or BTC-USD.");
  const method = body.method ?? "paper";
  const preset = forecastMethods.methods.find(item => item.id === method);
  if (!preset) throw new Error("Choose paper, validated, or custom forecasting.");
  const result = {
    ticker,
    method,
    methodologyVersion: forecastMethods.version,
    horizon: body.horizon ?? preset.horizon,
    model: body.model ?? "small",
    seedMode: body.seedMode ?? (body.seed === undefined || method === "validated" ? "reproducible" : "manual"),
    seed: 42,
    saveOutput: body.saveOutput ?? false,
    lookback: method === "custom" ? (body.lookback ?? preset.lookback) : preset.lookback,
    temperature: method === "custom" ? (body.temperature ?? preset.temperature) : preset.temperature,
    topP: method === "custom" ? (body.topP ?? preset.topP) : preset.topP,
    sampleCount: method === "custom" ? (body.sampleCount ?? preset.sampleCount) : preset.sampleCount,
    volumeMode: body.volumeMode ?? "auto",
    validationWindows: body.validationWindows ?? 3,
    objective: body.objective ?? "close_mae",
    fallbackToBaseline: body.fallbackToBaseline ?? false,
  };
  if (!["reproducible", "fresh", "manual"].includes(result.seedMode)) throw new Error("Choose a valid seed mode.");
  if (body.seed !== undefined && (!Number.isInteger(body.seed) || body.seed < 0 || body.seed > 2147483647)) throw new Error("Seed must be an integer from 0 to 2147483647.");
  if (result.seedMode === "manual") result.seed = body.seed ?? 42;
  if (result.seedMode === "fresh") result.seed = randomInt(2147483648);
  if (method === "validated" && result.seedMode !== "reproducible") throw new Error("Validation uses a fixed seed schedule for fair comparisons.");
  for (const [key, min, max] of [["lookback", 30, 512], ["sampleCount", 1, 30], ["validationWindows", 3, 8]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  for (const [key, min, max] of [["temperature", 0.1, 1.5], ["topP", 0.1, 1]]) {
    if (typeof result[key] !== "number" || !Number.isFinite(result[key]) || result[key] < min || result[key] > max) throw new Error(`${key} must be between ${min} and ${max}.`);
  }
  if (!["auto", "include", "exclude"].includes(result.volumeMode)) throw new Error("Choose auto, include, or exclude for volume inputs.");
  if (!["close_mae", "ohlc_mae"].includes(result.objective)) throw new Error("Choose close_mae or ohlc_mae as the accuracy objective.");
  if (typeof result.fallbackToBaseline !== "boolean") throw new Error("fallbackToBaseline must be a boolean.");
  if (method === "validated" && result.horizon > 20) throw new Error("Asset validation supports up to 20 future candles per run.");
  if (body.saveOutput !== undefined && typeof body.saveOutput !== "boolean")
    throw new Error("saveOutput must be a boolean.");
  if (
    !Number.isInteger(result.horizon) ||
    result.horizon < 1 ||
    result.horizon > 60
  )
    throw new Error("Forecast length must be 1–60 candles.");
  if (!["mini", "small", "base"].includes(result.model))
    throw new Error("Choose mini, small, or base.");
  for (const key of ["start", "end"]) {
    if (body[key] == null || body[key] === "") continue;
    const value = body[key];
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      throw new Error("Dates must be valid YYYY-MM-DD dates.");
    if (value < "1970-01-01" || value > new Date().toISOString().slice(0, 10))
      throw new Error("Dates must be between 1970 and today.");
    result[key] = value;
  }
  if (result.start && result.end && result.start > result.end)
    throw new Error("Start date must be on or before end date.");
  return result;
}
