export function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Provide a JSON object.");
  const ticker =
    typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
  if (!/^[A-Z0-9^][A-Z0-9.^=\-]{0,19}$/.test(ticker))
    throw new Error("Enter a valid ticker, such as AAPL, SPY, or BTC-USD.");
  const result = {
    ticker,
    horizon: body.horizon ?? 10,
    model: body.model ?? "small",
    seed: body.seed ?? 42,
  };
  if (
    !Number.isInteger(result.horizon) ||
    result.horizon < 1 ||
    result.horizon > 60
  )
    throw new Error("Forecast length must be 1–60 candles.");
  if (!["mini", "small", "base"].includes(result.model))
    throw new Error("Choose mini, small, or base.");
  if (
    !Number.isInteger(result.seed) ||
    result.seed < 0 ||
    result.seed > 2147483647
  )
    throw new Error("Seed must be an integer from 0 to 2147483647.");
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
