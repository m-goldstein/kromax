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
- **Paper preset** is the new default: 40 context candles, temperature 0.6, top-p 0.9, ten averaged paths and a 12-candle horizon. A changed horizon is labeled as a departure from that setup.
- **Validate on this asset** automatically selects settings by earlier historical error and audits the winner on two later windows. **Custom** exposes context, temperature, top-p and sample count. See [the research report](public/research.html), also available at http://localhost:3000/research.html, for sources, methodology and limitations.
- Context must contain the full requested number of consecutive completed sessions. After a missing/invalid price session, only the latest consecutive segment is eligible. Requests spanning more than 10 years are rejected.
- Prices are Yahoo's split/dividend-adjusted OHLC; volume comes from the provider. The model derives the optional amount feature from mean OHLC × volume, following its existing implementation.
- US exchange sessions skip weekends and holidays, including early closes when deciding whether today's candle is complete. Crypto uses completed UTC days and forecasts every calendar day. Unsupported exchanges fail explicitly.
- Forecasting begins after the final historical candle actually used. A historical end date therefore produces a historical scenario, not a forecast from today. Later observed candles are not fed into the predictor. Yahoo's revised/adjusted history and a pretrained model do not constitute a point-in-time backtest.
- Mini uses its 2k tokenizer/context; small and base use the base tokenizer and 512-token context, as documented upstream. Custom mode uses a common 30–512-candle application limit.
- Volume inputs default to included for stocks/ETFs and zeroed for crypto; users can override this. Turnover is derived from the effective volume. Original market volume remains in the displayed history.
- Reproducibility uses seed 42 by default; fresh and manual seeds are available outside validation. Seeds are never optimized for accuracy. Forecasts are averaged sampled scenarios, not calibrated confidence intervals. Identical seeds can still vary across devices, library versions, and revisions to market data.
- Kronos outputs unconstrained prices. Invalid/nonpositive prices fail explicitly. High/low values are expanded to contain all predicted OHLC values and negative volume is clamped to zero; the UI reports the count of corrected candles.
- Historical and predicted candles use separate chart colors. CSV export includes both, labeled by kind.

## Historical configuration selection

Choose **Validate on this asset**, the price-error objective (close MAE or OHLC MAE), and 3–8 selection windows. Four candidate configurations are defined in `forecast-methods.json`; this shared catalog also supplies the UI/API presets. Candidates compare context lengths 40/90/180 at temperature 0.6 plus context 90 at temperature 0.9, all with ten paths and top-p 0.9. These alternatives are a bounded application search, not universal optimal settings from the paper.

Selection windows and the two later audit windows each span the requested horizon and never overlap. Each prediction receives only prices preceding its origin. Candidate selection cannot inspect audit scores. Every candidate uses the same seed per window; the final forecast uses seed 42. Scores measure the chosen model and volume policy, which are not automatically searched.

Requires `180 + (validationWindows + 2) * horizon` consecutive candles: 240 with defaults or 195 for a three-candle horizon. Validation horizons are 1–20. Scored targets must start after June 2024, the paper's reported training cutoff; this does not verify the actual checkpoint's training contents. Expand the date range if data is insufficient. This mode runs `4 * validationWindows + 2` historical predictions plus a final forecast and can take minutes.

Results show selection MAE and the later audit's MAE compared with holding every future OHLC value at the last close. Error reduction is `100 * (1 - modelMAE / baselineMAE)`; positive is better, negative is worse, and zero baseline MAE produces `null` (N/A). JSON also retains close RMSE/MAPE, OHLC MAE and final-horizon direction agreement. These are price-error diagnostics, not trading profitability or confidence probabilities.

The optional **Use last-close baseline if audit fails** checkbox substitutes flat last-close candles (and copies last observed volume) if audit error is no better than the baseline. The result explicitly identifies this substitution; the displayed audit still describes the selected Kronos model. The audit cannot also serve as an unbiased evaluation of the fallback decision rule, since that decision uses its scores. Two audit windows are a small retrospective check; forward paper trails are needed to assess future performance.

## JSON forecast paper trails

Select **Save forecast JSON** before generating a forecast to archive that run on the server. The checkbox is unchecked by default. Files are written to the workspace's `outputs/` directory, next to `kromax/` and `Kronos/`, regardless of the directory used to launch Node. In this workspace that is `/home/max/kronos-maex/outputs/`.

Each successful opted-in run creates a separate `TIMESTAMP_TICKER_JOB-ID.json` file. Runs for the same ticker never replace previous forecasts. The UI displays the saved path only after the complete JSON file is published. Saved files survive server restarts and job expiration; generated output files are ignored by Git. Files remain on the server filesystem rather than downloading through the browser.

The versioned JSON document contains:

- `schemaVersion` (currently `1`), `forecastId`, and UTC `requestedAt`, `generatedAt`, and `savedAt` timestamps.
- `request`: the normalized ticker, dates (when supplied), horizon, model, effective seed, save option, method and method controls.
- `assets`: an array with the analyzed asset (one ticker per current request). Each entry includes `ticker`, `currency`, `interval`, `calendar`, model/device/seed/sampling settings, data source, adjustment flag, actual context dates, summary, and candle normalization count.
- `assets[].candles`: predicted candles with `date` (`YYYY-MM-DD` session date), `open`, `high`, `low`, `close`, and `volume`, stored as JSON numbers at full returned precision.
- `assets[].history`: original OHLCV for the final context, in the same dated format. `inputHistory` records effective model inputs after the volume policy. This preserves input prices even if the provider later revises them; turnover is derived by the predictor.
- `assets[].methodology`: actual selected settings, volume policy, seed mode, methodology version, evaluated model, and whether final candles come from Kronos or persistence.
- `assets[].evaluation` (validation mode): selection candidates, metrics, every dated prediction/actual/baseline, window boundaries and seeds, the separate audit, fallback decision and effective evaluation history. All archived candle arrays use `date`; the live chart API uses `time`.
- `assets[].provenance`: Kronos source commit, model identifier, PyTorch version, and SHA-256 of the effective final input frame serialized as pandas CSV. Model-weight revisions are not pinned by this metadata.

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

Join future observed prices by ticker and candle date using the same interval and adjustment basis to calculate accuracy later. The forecast origin is `assets[].context.end`; `generatedAt` records when inference actually ran. Historical scenarios should not be treated as forecasts made in the past. Validation mode includes retrospective scores; fetching newly realized prices and scoring archived forward forecasts remain separate steps.

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
{"ticker":"AAPL","start":"2024-07-01","end":"2025-07-03","method":"validated","horizon":3,"model":"small","validationWindows":3,"objective":"close_mae","fallbackToBaseline":false,"saveOutput":true}
```

Only `ticker` is required. Returns HTTP 202 with a job `id`. `GET /api/methods` returns the versioned shared preset/candidate catalog.

| Input | Values / default |
| --- | --- |
| `method` | `paper` (default), `validated`, `custom` |
| `horizon` | 1–60; default 12 for paper/validated, 10 for custom; validation capped at 20 |
| `model` | `mini`, `small` (default), `base` |
| `lookback` | Custom only, 30–512; default 400 |
| `temperature`, `topP`, `sampleCount` | Custom only, 0.1–1.5 / 0.1–1 / 1–30; defaults 1 / 0.9 / 1 |
| `volumeMode` | `auto` (default), `include`, `exclude` |
| `seedMode` | `reproducible` (default), `fresh`, `manual`; validation requires reproducible |
| `seed` | Integer 0–2147483647 for manual mode. Supplying only `seed` retains legacy manual behavior outside validation. Reproducible/validated always use 42. Fresh mode resolves and records a random seed on submission. |
| `validationWindows` | Integer 3–8, default 3 |
| `objective` | `close_mae` (default), `ohlc_mae` |
| `fallbackToBaseline` | Boolean, default false; only used by validation |

Paper/validated settings are server-controlled; custom sampling fields do not override them. Validation controls have no effect on paper/custom forecasts.

`saveOutput` is an optional boolean (default `false`). On completion, opted-in jobs also return `output: {status: "saved", path: "outputs/...json", savedAt: "..."}` or `output: {status: "failed", error: "..."}` if archiving failed. In either case the successful forecast stays in `result`.

`GET /api/forecasts/:id` returns `queued`, `running`, `complete`, or `failed`, a progress message, and a `result` or `error` when finished. Results include model/data metadata, the actual context window, historical/forecast OHLCV arrays, and a price summary. `GET /api/health` reports API availability and queue state; it does not assert that models are downloaded or data providers are reachable.

Jobs execute one at a time, with up to five waiting jobs. Excess submissions return 429. Results are held in memory; older completed jobs are pruned on new submissions (one hour / about 100 jobs). Restarting Node clears jobs. A timed-out/crashed Python worker is restarted on the next job. There is no database, authentication, or trading integration. The only baseline substitution is the explicit validation option described above.

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

API tests cover bounded controls, preset enforcement, seed modes, progress/results, queue bounds, archiving, failures and static assets. Python tests cover calendars, invalid prices, input shape, volume policy, context gaps, metric arithmetic, temporal separation, fixed seed schedules, selection before auditing, and baseline opt-in. Browser tests cover all three methods, audit display, expanded JSON, candlestick rendering, CSV download, responsive layout and provider errors. Ordinary browser tests use an isolated test-only worker; the opt-in live suite runs the real pipeline. Playwright starts its own server on port 3100.

## Documentation consulted

- [Kronos README and forecasting API](../Kronos/README.md), [predictor implementation](../Kronos/model/kronos.py), and [existing Python web UI](../Kronos/webui/README.md).
- [yfinance history parameters](https://ranaroussi.github.io/yfinance/reference/yfinance.price_history.html): inclusive start, exclusive provider end, and adjusted OHLC.
- [pandas-market-calendars sessions](https://pandas-market-calendars.readthedocs.io/en/latest/usage.html): session dates and market close schedules.
- [Lightweight Charts 4.2 API](https://tradingview.github.io/lightweight-charts/docs/4.2/api/interfaces/IChartApi): local candlestick chart integration. TradingView attribution appears in the UI.

Kronos retains its MIT license. Third-party packages retain their respective licenses.
