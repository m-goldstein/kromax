# Kromax

A Node.js/Express API and AngularJS frontend backed by the separate Kronos checkout's real Python `KronosPredictor`. Enter a Yahoo Finance ticker and optional historical dates to forecast the next daily OHLCV candles. Supports US-listed stocks/ETFs (e.g. AAPL, NVDA, SPY) and crypto (e.g. BTC-USD).

## Run locally

The app and upstream repository live in separate sibling directories:

```text
kronos-maex/
├── Kronos/       # Upstream Git checkout; no app changes
└── kromax/   # Frontend, API, tests, and Python environment
```

Dependencies are already installed in this workspace. To start:

```bash
cd /home/max/kronos-maex/kromax
npm start
```

Requires Node.js 20+ and Python 3.10+ (tested with Node 22 and Python 3.12). For a fresh installation, run from `kromax/`:

```bash
npm ci
python3 -m venv .venv
# CPU installation; use your platform's PyTorch CUDA build for GPU inference instead.
.venv/bin/pip install 'torch>=2.0,<3' --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install -r python/requirements.txt
npm start
```

Open http://localhost:3000. `npm run dev` restarts the Node server after server changes. There is no frontend build step and no API key is required. Browser dependencies are served locally, not from a CDN.

The worker finds `../Kronos` relative to the app directory automatically. If you store Kronos elsewhere, provide its path when starting the app:

```bash
KRONOS_REPO=/absolute/path/to/Kronos npm start
```

To update upstream, stop the app with Ctrl+C, pull the separate checkout, then start the app again:

```bash
git -C /home/max/kronos-maex/Kronos pull --ff-only
cd /home/max/kronos-maex/kromax
npm start
```

Pulling Kronos does not touch the app files. Upstream API or dependency changes may still require corresponding app updates. The app has its own `.gitignore` and can be versioned independently.

The Node process starts the Python worker on the first request. Model weights download from Hugging Face on first use and are cached in the standard Hugging Face cache. Subsequent forecasts reuse the loaded model. Internet access is required for Yahoo Finance and initial model downloads. Select mini for faster CPU inference.

On Windows, use `.venv\Scripts\python.exe` for Python commands and set `PYTHON_BIN` to that executable before starting Node.

## Behavior

- Daily candles only. Start and end dates are inclusive. Missing end means today; missing start means two years before the end.
- Up to the latest 400 valid, completed candles within the requested window become the model context. At least 30 are required. Requests spanning more than 10 years are rejected.
- Prices are Yahoo's split/dividend-adjusted OHLC; volume comes from the provider. The model derives the optional amount feature from mean OHLC × volume, following its existing implementation.
- US exchange sessions skip weekends and holidays, including early closes when deciding whether today's candle is complete. Crypto uses completed UTC days and forecasts every calendar day. Unsupported exchanges fail explicitly.
- Forecasting begins after the final historical candle actually used. A historical end date therefore produces a historical scenario, not a forecast from today. Later observed candles are not fed into the predictor. Yahoo's revised/adjusted history and a pretrained model do not constitute a point-in-time backtest.
- Mini uses its 2k tokenizer/context; small and base use the base tokenizer and 512-token context, as documented upstream. All use the same 400-candle application limit.
- Temperature is 1.0, top-p is 0.9, and sample count is 1. The seed is configurable. Forecasts are sampled scenarios, not calibrated confidence intervals. Identical seeds can still vary across devices, library versions, and revisions to market data.
- Kronos outputs unconstrained prices. Invalid/nonpositive prices fail explicitly. High/low values are expanded to contain all predicted OHLC values and negative volume is clamped to zero; the UI reports the count of corrected candles.
- Historical and predicted candles use separate chart colors. CSV export includes both, labeled by kind.

## JSON forecast paper trails

Select **Save forecast JSON** before generating a forecast to archive that run on the server. The checkbox is unchecked by default. Files are written to the workspace's `outputs/` directory, next to `kromax/` and `Kronos/`, regardless of the directory used to launch Node. In this workspace that is `/home/max/kronos-maex/outputs/`.

Each successful opted-in run creates a separate `TIMESTAMP_TICKER_JOB-ID.json` file. Runs for the same ticker never replace previous forecasts. The UI displays the saved path only after the complete JSON file is published. Saved files survive server restarts and job expiration; generated output files are ignored by Git. Files remain on the server filesystem rather than downloading through the browser.

The versioned JSON document contains:

- `schemaVersion` (currently `1`), `forecastId`, and UTC `requestedAt`, `generatedAt`, and `savedAt` timestamps.
- `request`: the normalized ticker, dates (when supplied), horizon, model, seed, and save option.
- `assets`: an array with the analyzed asset (one ticker per current request). Each entry includes `ticker`, `currency`, `interval`, `calendar`, model/device/seed/sampling settings, data source, adjustment flag, actual context dates, summary, and candle normalization count.
- `assets[].candles`: predicted candles with `date` (`YYYY-MM-DD` session date), `open`, `high`, `low`, `close`, and `volume`, stored as JSON numbers at full returned precision.
- `assets[].history`: the historical OHLCV input snapshot in the same dated format. This preserves the input prices even if the provider later revises them.

For example, to read the dated predictions from a saved file:

```python
import json
from pathlib import Path

for path in Path("outputs").glob("*.json"):
    record = json.loads(path.read_text())
    for asset in record["assets"]:
        for candle in asset["candles"]:
            print(record["forecastId"], asset["ticker"], candle["date"], candle["close"])
```

Join future observed prices by ticker and candle date using the same interval and adjustment basis to calculate accuracy later. The forecast origin is `assets[].context.end`; `generatedAt` records when inference actually ran. Historical scenarios should not be treated as forecasts made in the past. These files record forecasts and inputs; fetching realized prices and computing accuracy metrics are separate steps.

Failed inference produces no output file. If forecasting succeeds but saving fails, the chart remains available and the UI reports that the run has not been archived.

## Architecture and API

```text
AngularJS + Lightweight Charts
    → POST /api/forecasts → Express bounded job queue
    → persistent Python worker (NDJSON over stdin/stdout)
    → yfinance → completed-session filtering → KronosPredictor
    → GET /api/forecasts/:id → chart, summary, table, CSV
```

`POST /api/forecasts` accepts:

```json
{"ticker":"AAPL","start":"2025-01-01","end":"2025-07-03","horizon":10,"model":"small","seed":42,"saveOutput":true}
```

Only `ticker` is required. `horizon` is 1–60 (default 10), `model` is `mini`, `small`, or `base` (default small), and `seed` is a nonnegative 32-bit signed integer (default 42). Returns HTTP 202 with a job `id`.

`saveOutput` is an optional boolean (default `false`). On completion, opted-in jobs also return `output: {status: "saved", path: "outputs/...json", savedAt: "..."}` or `output: {status: "failed", error: "..."}` if archiving failed. In either case the successful forecast stays in `result`.

`GET /api/forecasts/:id` returns `queued`, `running`, `complete`, or `failed`, a progress message, and a `result` or `error` when finished. Results include model/data metadata, the actual context window, historical/forecast OHLCV arrays, and a price summary. `GET /api/health` reports API availability and queue state; it does not assert that models are downloaded or data providers are reachable.

Jobs execute one at a time, with up to five waiting jobs. Excess submissions return 429. Results are held in memory; older completed jobs are pruned on new submissions (one hour / about 100 jobs). Restarting Node clears jobs. A timed-out/crashed Python worker is restarted on the next job. There is no database, authentication, trading integration, or synthetic fallback in the application.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `3000` | HTTP port |
| `PYTHON_BIN` | `.venv/bin/python`, then `python3` | Python interpreter |
| `KRONOS_REPO` | Sibling `../Kronos` directory | Path to the upstream Kronos checkout |
| `KRONOS_DEVICE` | Auto-detect | `cpu`, `cuda:0`, or `mps` |
| `KRONOS_THREADS` | `4` | PyTorch CPU thread count |
| `JOB_TIMEOUT_MS` | `900000` | Per-job time limit including first model download |

This is a local research workspace. AngularJS 1.8.3 is used as requested; it is end-of-life and `npm audit` reports an unpatched high-severity AngularJS dependency finding. Keep the default loopback binding; a public deployment needs a supported frontend/security maintenance plan, authentication, rate limits, and durable job storage.

## Verification

```bash
npm test
npm run test:python
npx playwright install chromium
npm run test:browser
# Optional real Yahoo Finance + Hugging Face + Kronos browser integration:
KRONOS_LIVE=1 npm run test:browser
```

API tests cover validation, progress/results, queue bounds, serialization, failures, static assets, and a missing Python executable. Python tests cover holidays, early closes, unfinished crypto candles, invalid prices, model input shape, date cutoffs, and context truncation. Browser tests cover submission, candlestick rendering, CSV download, responsive layout, validation, and retry after provider errors. Ordinary browser tests use an isolated test-only worker; the opt-in live suite runs the real pipeline. Playwright starts its own server on port 3100.

## Documentation consulted

- [Kronos README and forecasting API](../Kronos/README.md), [predictor implementation](../Kronos/model/kronos.py), and [existing Python web UI](../Kronos/webui/README.md).
- [yfinance history parameters](https://ranaroussi.github.io/yfinance/reference/yfinance.price_history.html): inclusive start, exclusive provider end, and adjusted OHLC.
- [pandas-market-calendars sessions](https://pandas-market-calendars.readthedocs.io/en/latest/usage.html): session dates and market close schedules.
- [Lightweight Charts 4.2 API](https://tradingview.github.io/lightweight-charts/docs/4.2/api/interfaces/IChartApi): local candlestick chart integration. TradingView attribution appears in the UI.

Kronos retains its MIT license. Third-party packages retain their respective licenses.
