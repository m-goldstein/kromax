"""Daily market data and inference adapter for the checked-out Kronos source."""
from datetime import date, timedelta
from pathlib import Path
import os
import sys

import numpy as np
import pandas as pd
import pandas_market_calendars as calendars
import yfinance as yf

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
        raise ValueError('The model produced invalid prices. Try another seed or a shorter forecast.')
    high = frame[PRICE_COLUMNS].max(axis=1)
    low = frame[PRICE_COLUMNS].min(axis=1)
    corrected = int(((high != frame['high']) | (low != frame['low']) | (frame['volume'] < 0)).sum())
    frame['high'], frame['low'] = high, low
    frame['volume'] = frame['volume'].clip(lower=0)
    return frame, corrected


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
            raise ValueError('Choose a historical range of at most 10 years. The latest 400 valid candles are used.')
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
        if available < 30:
            raise ValueError(f'Only {available} completed candles are available. Choose a range with at least 30 candles.')
        frame = frame.tail(400)
        dates = future_dates(frame.index[-1], request['horizon'], calendar)
        predictor = self.load_model(request['model'], progress)
        progress(f'Generating {request["horizon"]} future candles from {len(frame)} historical candles on {predictor.device}…')
        import torch
        torch.manual_seed(request['seed'])
        np.random.seed(request['seed'])
        with torch.inference_mode():
            prediction = predictor.predict(
                df=frame.reset_index(drop=True), x_timestamp=pd.Series(frame.index),
                y_timestamp=pd.Series(dates), pred_len=len(dates),
                T=1.0, top_p=0.9, sample_count=1, verbose=False,
            )
        prediction, corrected = normalize_prediction(prediction)
        last_close = float(frame['close'].iloc[-1])
        final_close = float(prediction['close'].iloc[-1])
        return {
            'ticker': ticker, 'currency': metadata.get('currency', ''),
            'name': metadata.get('longName') or metadata.get('shortName') or ticker,
            'interval': '1d', 'calendar': calendar, 'model': f'Kronos-{request["model"]}',
            'device': str(predictor.device), 'seed': request['seed'],
            'sampling': {'temperature': 1.0, 'topP': 0.9, 'sampleCount': 1},
            'source': 'Yahoo Finance via yfinance', 'adjusted': True,
            'generatedAt': pd.Timestamp.now(tz='UTC').isoformat(),
            'requestedRange': {'start': start.isoformat(), 'end': end.isoformat()},
            'context': {'used': len(frame), 'available': available, 'start': frame.index[0].strftime('%Y-%m-%d'), 'end': frame.index[-1].strftime('%Y-%m-%d')},
            'history': candles(frame), 'forecast': candles(prediction),
            'summary': {'lastClose': last_close, 'forecastClose': final_close,
                        'changePercent': (final_close / last_close - 1) * 100,
                        'forecastHigh': float(prediction['high'].max()), 'forecastLow': float(prediction['low'].min())},
            'normalizedCandles': corrected,
        }
