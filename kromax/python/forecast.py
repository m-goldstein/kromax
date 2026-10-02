"""Daily market data and inference adapter for the checked-out Kronos source."""
from datetime import date, timedelta
from pathlib import Path
import os
import sys
import hashlib
import subprocess

import numpy as np
import pandas as pd
import pandas_market_calendars as calendars
import yfinance as yf
from evaluation import CATALOG, select_configuration, persistence

KRONOS_REPO = Path(os.environ.get('KRONOS_REPO') or Path(__file__).resolve().parents[2] / 'Kronos').expanduser().resolve()
PRICE_COLUMNS = ['open', 'high', 'low', 'close']
US_EXCHANGES = {'NYQ', 'NMS', 'NGM', 'NCM', 'ASE', 'PCX', 'BTS', 'BATS', 'NAS', 'NYSE', 'NASDAQ', 'NYS', 'ARCA'}


def market_calendar(metadata):
    if metadata.get('instrumentType') == 'CRYPTOCURRENCY':
        return '24/7'
    if metadata.get('exchangeName') in US_EXCHANGES:
        return 'NYSE'
    raise ValueError('This version supports US-listed stocks/ETFs and crypto. Try AAPL, SPY, or BTC-USD.')


def clean_history(frame, calendar, now=None):
    """Keep valid, completed daily candles, preserving exchange-local session dates."""
    now = pd.Timestamp.now(tz='UTC') if now is None else pd.Timestamp(now)
    frame = frame.rename(columns=str.lower).copy()
    if not all(column in frame for column in PRICE_COLUMNS):
        raise ValueError('The data provider did not return OHLC candles.')
    frame.index = pd.DatetimeIndex(frame.index).tz_localize(None).normalize()
    frame = frame[~frame.index.duplicated(keep='last')].sort_index()
    if 'volume' not in frame:
        frame['volume'] = 0.0
    frame = frame[PRICE_COLUMNS + ['volume']].apply(pd.to_numeric, errors='coerce')
    frame = frame.replace([np.inf, -np.inf], np.nan).dropna(subset=PRICE_COLUMNS)
    frame['volume'] = frame['volume'].fillna(0).clip(lower=0)
    valid = (frame[PRICE_COLUMNS] > 0).all(axis=1)
    valid &= frame['high'] >= frame[['open', 'close', 'low']].max(axis=1)
    valid &= frame['low'] <= frame[['open', 'close', 'high']].min(axis=1)
    frame = frame.loc[valid]
    if frame.empty:
        raise ValueError('No usable candles were returned for this ticker and date range.')
    if calendar == '24/7':
        frame = frame[frame.index < now.tz_convert('UTC').tz_localize(None).normalize()]
    else:
        schedule = calendars.get_calendar(calendar).schedule(frame.index.min(), frame.index.max())
        completed = schedule.index[schedule['market_close'] <= now]
        frame = frame[frame.index.isin(completed)]
    return frame


def future_dates(last_date, count, calendar):
    start = pd.Timestamp(last_date) + pd.Timedelta(days=1)
    if calendar == '24/7':
        return pd.date_range(start, periods=count, freq='D')
    dates = calendars.get_calendar(calendar).valid_days(start, start + pd.Timedelta(days=count * 3 + 30))
    return dates.tz_localize(None)[:count]


def candles(frame):
    return [dict(time=pd.Timestamp(index).strftime('%Y-%m-%d'), **{
        column: float(row[column]) for column in PRICE_COLUMNS + ['volume']
    }) for index, row in frame.iterrows()]


def normalize_prediction(frame):
    """Project unconstrained model outputs onto valid OHLC candle geometry."""
    frame = frame.copy()
    if not np.isfinite(frame[PRICE_COLUMNS + ['volume']].to_numpy()).all() or (frame[PRICE_COLUMNS] <= 0).any().any():
        raise ValueError('The model produced invalid prices. Try a shorter forecast or review the input data.')
    high = frame[PRICE_COLUMNS].max(axis=1)
    low = frame[PRICE_COLUMNS].min(axis=1)
    corrected = int(((high != frame['high']) | (low != frame['low']) | (frame['volume'] < 0)).sum())
    frame['high'], frame['low'] = high, low
    frame['volume'] = frame['volume'].clip(lower=0)
    return frame, corrected


def consecutive_history(frame, calendar):
    """Do not join disjoint trading segments after missing/invalid price rows."""
    if frame.empty:
        return frame
    if calendar == '24/7':
        sessions = pd.date_range(frame.index[0], frame.index[-1], freq='D')
    else:
        sessions = calendars.get_calendar(calendar).valid_days(frame.index[0], frame.index[-1]).tz_localize(None)
    positions = sessions.get_indexer(frame.index)
    breaks = np.flatnonzero(np.diff(positions) != 1)
    return frame.iloc[breaks[-1] + 1:] if len(breaks) else frame


def source_revision():
    try:
        return subprocess.check_output(['git', '-C', str(KRONOS_REPO), 'rev-parse', 'HEAD'], text=True, stderr=subprocess.DEVNULL, timeout=5).strip()
    except (OSError, subprocess.SubprocessError):
        return None


class Forecaster:
    def __init__(self):
        self.predictor = None
        self.model_name = None

    def load_model(self, name, progress):
        if self.model_name == name and self.predictor is not None:
            return self.predictor
        progress(f'Loading Kronos-{name}. First use downloads model weights from Hugging Face…')
        if not (KRONOS_REPO / 'model' / 'kronos.py').is_file():
            raise ValueError(f'Kronos source not found at {KRONOS_REPO}. Set KRONOS_REPO to your Kronos checkout directory and restart the server.')
        sys.path.insert(0, str(KRONOS_REPO))
        import torch
        from model import Kronos, KronosTokenizer, KronosPredictor
        torch.set_num_threads(max(1, int(os.environ.get('KRONOS_THREADS', '4'))))
        # Release the previous model before loading another to bound memory use.
        self.predictor = None
        self.model_name = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        tokenizer_id = 'NeoQuasar/Kronos-Tokenizer-2k' if name == 'mini' else 'NeoQuasar/Kronos-Tokenizer-base'
        tokenizer = KronosTokenizer.from_pretrained(tokenizer_id).eval()
        model = Kronos.from_pretrained(f'NeoQuasar/Kronos-{name}').eval()
        self.predictor = KronosPredictor(model, tokenizer, device=os.environ.get('KRONOS_DEVICE') or None, max_context=2048 if name == 'mini' else 512)
        self.model_name = name
        return self.predictor

    def run(self, request, progress):
        ticker = request['ticker']
        end = date.fromisoformat(request.get('end') or date.today().isoformat())
        start = date.fromisoformat(request['start']) if request.get('start') else end - timedelta(days=730)
        if (end - start).days > 3660:
            raise ValueError('Choose a historical range of at most 10 years.')
        progress(f'Fetching daily candles for {ticker}…')
        stock = yf.Ticker(ticker)
        try:
            raw = stock.history(start=start.isoformat(), end=(end + timedelta(days=1)).isoformat(), interval='1d', auto_adjust=True, actions=False, timeout=30, raise_errors=True)
            if raw.empty:
                raise ValueError('No price history was returned.')
            metadata = stock.get_history_metadata()
        except Exception as error:
            raise ValueError(f'Could not load {ticker}. Check the ticker/date range or retry if Yahoo Finance is unavailable. ({type(error).__name__})') from error
        calendar = market_calendar(metadata)
        frame = clean_history(raw, calendar)
        # Enforce the requested window even if the provider returns extra rows.
        frame = frame.loc[start.isoformat():end.isoformat()]
        available = len(frame)
        frame = consecutive_history(frame, calendar)
        contiguous_count = len(frame)
        settings = {key: request.get(key, default) for key, default in {'lookback': 400, 'temperature': 1.0, 'topP': 0.9, 'sampleCount': 1}.items()}
        if len(frame) < settings['lookback']:
            raise ValueError(f'Only {len(frame)} consecutive completed candles are available; this method needs {settings["lookback"]}. Expand the range or choose a shorter custom context.')
        method = request.get('method', 'custom')
        volume_mode = request.get('volumeMode', 'auto')
        include_volume = volume_mode == 'include' or (volume_mode == 'auto' and calendar != '24/7')
        model_frame = frame.copy()
        if not include_volume:
            model_frame['volume'] = 0.0
        predictor = self.load_model(request['model'], progress)
        import torch

        def predict(context, targets, config, seed):
            torch.manual_seed(seed)
            np.random.seed(seed)
            with torch.inference_mode():
                output = predictor.predict(
                    df=context.reset_index(drop=True), x_timestamp=pd.Series(context.index),
                    y_timestamp=pd.Series(targets), pred_len=len(targets),
                    T=config['temperature'], top_p=config['topP'], top_k=0,
                    sample_count=config['sampleCount'], verbose=False,
                )
            return output

        evaluation = None
        if method == 'validated':
            settings, evaluation = select_configuration(
                model_frame, request,
                lambda context, targets, config, seed: normalize_prediction(predict(context, targets, config, seed))[0],
                progress, candles,
            )
        frame = frame.tail(settings['lookback'])
        model_frame = model_frame.tail(settings['lookback'])
        dates = future_dates(frame.index[-1], request['horizon'], calendar)
        fallback = bool(evaluation and evaluation['baselineFallback'])
        progress('Using last-close baseline after the historical audit…' if fallback else f'Generating {request["horizon"]} candles using {settings["sampleCount"]} averaged paths on {predictor.device}…')
        prediction = persistence(frame, dates) if fallback else predict(model_frame, dates, settings, request['seed'])
        prediction, corrected = normalize_prediction(prediction)
        last_close = float(frame['close'].iloc[-1])
        final_close = float(prediction['close'].iloc[-1])
        return {
            'ticker': ticker, 'currency': metadata.get('currency', ''),
            'name': metadata.get('longName') or metadata.get('shortName') or ticker,
            'interval': '1d', 'calendar': calendar, 'model': 'Persistence baseline' if fallback else f'Kronos-{request["model"]}',
            'device': str(predictor.device), 'seed': request['seed'],
            'sampling': {'temperature': settings['temperature'], 'topP': settings['topP'], 'sampleCount': settings['sampleCount'], 'topK': 0, 'aggregation': 'mean'},
            'methodology': {'method': method, 'version': CATALOG['version'], 'settings': settings,
                            'volumeIncluded': include_volume, 'seedMode': request.get('seedMode', 'manual'),
                            'forecastMethod': 'persistence' if fallback else 'kronos', 'evaluatedModel': f'Kronos-{request["model"]}',
                            'baselineDefinition': 'Repeat last close for OHLC and last observed volume; no predicted range.' if fallback else None},
            'evaluation': evaluation,
            'provenance': {'kronosCommit': source_revision(), 'torchVersion': torch.__version__,
                           'modelId': f'NeoQuasar/Kronos-{request["model"]}',
                           'inputSha256': hashlib.sha256(model_frame.to_csv().encode()).hexdigest()},
            'inputHistory': candles(model_frame),
            'dataQuality': {'consecutiveCandles': contiguous_count, 'excludedEarlierCandles': available - contiguous_count,
                            'zeroVolumeCandles': int((frame['volume'] == 0).sum()),
                            'largeMoveCandles': int((frame['close'].pct_change().abs() > 0.30).sum())},
            'source': 'Yahoo Finance via yfinance', 'adjusted': True,
            'generatedAt': pd.Timestamp.now(tz='UTC').isoformat(),
            'requestedRange': {'start': start.isoformat(), 'end': end.isoformat()},
            'context': {'used': len(frame), 'available': available, 'requested': settings['lookback'], 'start': frame.index[0].strftime('%Y-%m-%d'), 'end': frame.index[-1].strftime('%Y-%m-%d')},
            'history': candles(frame), 'forecast': candles(prediction),
            'summary': {'lastClose': last_close, 'forecastClose': final_close,
                        'changePercent': (final_close / last_close - 1) * 100,
                        'forecastHigh': float(prediction['high'].max()), 'forecastLow': float(prediction['low'].min())},
            'normalizedCandles': corrected,
        }
