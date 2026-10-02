from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from forecast import Forecaster, clean_history, future_dates, market_calendar, normalize_prediction


class DataTests(unittest.TestCase):
    def test_exchange_holidays_and_crypto_weekends(self):
        self.assertEqual(list(future_dates('2025-07-03', 2, 'NYSE').strftime('%Y-%m-%d')), ['2025-07-07', '2025-07-08'])
        self.assertEqual(list(future_dates('2025-07-03', 3, '24/7').strftime('%Y-%m-%d')), ['2025-07-04', '2025-07-05', '2025-07-06'])

    def test_incomplete_session_and_invalid_candles_removed(self):
        frame = pd.DataFrame({'Open': [10, 11, 0, 12], 'High': [12, 13, 13, 14], 'Low': [9, 10, 10, 11], 'Close': [11, 12, 12, 13]}, index=pd.to_datetime(['2025-07-02', '2025-07-03', '2025-07-03', '2025-07-07']))
        # July 3 is an early close. July 7 has not closed at 19:00 UTC.
        result = clean_history(frame, 'NYSE', pd.Timestamp('2025-07-07T19:00:00Z'))
        self.assertEqual(list(result.index.strftime('%Y-%m-%d')), ['2025-07-02'])
        self.assertEqual(result.volume.iloc[0], 0)

    def test_early_close_and_crypto_current_day(self):
        frame = pd.DataFrame({'open': [10, 10], 'high': [12, 12], 'low': [9, 9], 'close': [11, 11]}, index=pd.to_datetime(['2025-07-02', '2025-07-03']))
        now = pd.Timestamp('2025-07-03T17:01:00Z')
        self.assertEqual(len(clean_history(frame, 'NYSE', now)), 2)
        self.assertEqual(len(clean_history(frame, '24/7', now)), 1)

    def test_unsupported_exchange_is_explicit(self):
        self.assertEqual(market_calendar({'exchangeName': 'NMS'}), 'NYSE')
        self.assertEqual(market_calendar({'instrumentType': 'CRYPTOCURRENCY'}), '24/7')
        with self.assertRaisesRegex(ValueError, 'supports US'):
            market_calendar({'exchangeName': 'LSE'})

    def test_prediction_geometry_and_invalid_output(self):
        frame = pd.DataFrame({'open': [10.], 'high': [9.], 'low': [12.], 'close': [11.], 'volume': [-2.]})
        corrected, count = normalize_prediction(frame)
        self.assertEqual(count, 1)
        self.assertEqual(corrected.high.iloc[0], 12)
        self.assertEqual(corrected.low.iloc[0], 9)
        self.assertEqual(corrected.volume.iloc[0], 0)
        frame.loc[0, 'close'] = np.nan
        with self.assertRaisesRegex(ValueError, 'invalid prices'):
            normalize_prediction(frame)

    @patch('forecast.yf.Ticker')
    def test_range_cutoff_context_limit_and_predictor_contract(self, ticker):
        index = pd.date_range('2023-01-01', '2025-01-31')
        raw = pd.DataFrame({'Open': 10., 'High': 12., 'Low': 9., 'Close': 11., 'Volume': 100.}, index=index)
        ticker.return_value.history.return_value = raw
        ticker.return_value.get_history_metadata.return_value = {'instrumentType': 'CRYPTOCURRENCY', 'currency': 'USD'}
        engine = Forecaster()
        class Predictor:
            device = 'cpu'
            def predict(self, **kwargs):
                self.kwargs = kwargs
                return pd.DataFrame({'open': 10., 'high': 12., 'low': 9., 'close': 11., 'volume': 100.}, index=kwargs['y_timestamp'])
        predictor = Predictor()
        with patch.object(engine, 'load_model', return_value=predictor):
            result = engine.run({'ticker': 'BTC-USD', 'end': '2024-12-31', 'horizon': 3, 'model': 'mini', 'seed': 42}, lambda message: None)
        self.assertEqual(result['context']['used'], 400)
        self.assertEqual(result['context']['end'], '2024-12-31')
        self.assertEqual(result['forecast'][0]['time'], '2025-01-01')
        self.assertEqual(len(predictor.kwargs['df']), 400)
        self.assertEqual(predictor.kwargs['pred_len'], 3)
        self.assertEqual(ticker.return_value.history.call_args.kwargs['end'], '2025-01-01')


if __name__ == '__main__':
    unittest.main()
