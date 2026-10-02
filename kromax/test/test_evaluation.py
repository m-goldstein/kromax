from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from evaluation import CATALOG, persistence, plan_windows, score, select_configuration
from forecast import Forecaster, candles, consecutive_history


def history(length=210, start='2025-01-01'):
    close = np.arange(length, dtype=float) + 100
    return pd.DataFrame({'open': close, 'high': close + 1, 'low': close - 1,
                         'close': close, 'volume': 1000.}, index=pd.date_range(start, periods=length))


class EvaluationTests(unittest.TestCase):
    def request(self, **overrides):
        return {'horizon': 3, 'validationWindows': 3, 'seed': 42,
                'objective': 'close_mae', 'fallbackToBaseline': False, **overrides}

    def test_windows_are_disjoint_and_require_full_context(self):
        self.assertEqual(plan_windows(195, 3, 3), [(180, 183), (183, 186), (186, 189), (189, 192), (192, 195)])
        with self.assertRaisesRegex(ValueError, 'at least 196'):
            plan_windows(195, 2, 6)

    def test_price_errors_and_persistence_are_not_directional_accuracy(self):
        context = history(1)
        actual = history(3).iloc[1:]
        predicted = persistence(context, actual.index)
        metrics = score(predicted, actual, context, 'close_mae')
        self.assertEqual(metrics['closeMAE'], 1.5)
        self.assertAlmostEqual(metrics['closeRMSE'], np.sqrt(2.5))
        self.assertEqual(metrics['baselineMAE'], metrics['objectiveMAE'])
        self.assertEqual(metrics['endpointDirectionAccuracyPercent'], 0)
        self.assertEqual(metrics['ohlcMAE'], 1.5)
        predicted.index = predicted.index + pd.Timedelta(days=1)
        with self.assertRaisesRegex(ValueError, 'dates must match'):
            score(predicted, actual, context, 'close_mae')

    def test_selection_uses_only_earlier_targets_and_never_selects_on_audit(self):
        frame = history()
        audit_start = frame.index[-6]
        calls = []

        def predict(context, dates, candidate, seed):
            self.assertLess(context.index.max(), dates.min())
            self.assertEqual(len(context), candidate['lookback'])
            calls.append((candidate['id'], dates[0], seed))
            result = frame.loc[dates].copy()
            # Paper wins tuning, but would lose if we illegitimately re-selected on audit.
            error = (20 if dates[0] >= audit_start else 0) if candidate['id'] == 'paper-40' else 1
            result[['open', 'high', 'low', 'close']] += error
            return result

        settings, report = select_configuration(frame, self.request(fallbackToBaseline=True), predict, lambda _: None, candles)
        self.assertEqual(settings['id'], 'paper-40')
        self.assertEqual(report['audit']['metrics']['closeMAE'], 20)
        self.assertTrue(report['baselineFallback'])
        self.assertEqual(len(calls), 14)
        self.assertTrue(all(candidate == 'paper-40' for candidate, day, _ in calls if day >= audit_start))
        for candidate in CATALOG['candidates']:
            self.assertEqual([seed for name, day, seed in calls if name == candidate['id'] and day < audit_start], [42, 43, 44])
        self.assertEqual([seed for _, day, seed in calls if day >= audit_start], [45, 46])
        self.assertEqual(report['history'][-1]['time'], frame.index[-1].strftime('%Y-%m-%d'))

    def test_baseline_is_explicitly_opt_in_and_zero_error_has_no_skill_ratio(self):
        frame = history()
        frame[['open', 'high', 'low', 'close']] = 100.
        def predict(context, dates, candidate, seed):
            return persistence(context, dates)
        _, report = select_configuration(frame, self.request(), predict, lambda _: None, candles)
        self.assertFalse(report['baselineFallback'])
        self.assertIsNone(report['audit']['metrics']['skillPercent'])

    def test_validation_refuses_targets_in_stated_pretraining_period(self):
        with self.assertRaisesRegex(ValueError, 'after June 2024'):
            select_configuration(history(start='2023-01-01'), self.request(), None, None, candles)

    def test_objective_changes_selection_when_close_and_range_accuracy_disagree(self):
        frame = history()
        def predict(context, dates, candidate, seed):
            output = frame.loc[dates].copy()
            if candidate['id'] == 'paper-40':
                output['high'] += 20
                output['low'] -= 20
            else:
                output[['open', 'high', 'low', 'close']] += 1
            return output
        close_settings, _ = select_configuration(frame, self.request(), predict, lambda _: None, candles)
        ohlc_settings, _ = select_configuration(frame, self.request(objective='ohlc_mae'), predict, lambda _: None, candles)
        self.assertEqual(close_settings['id'], 'paper-40')
        self.assertEqual(ohlc_settings['id'], 'context-90')

    def test_missing_sessions_are_not_stitched_together(self):
        frame = history(10).drop(pd.Timestamp('2025-01-05'))
        result = consecutive_history(frame, '24/7')
        self.assertEqual(result.index[0], pd.Timestamp('2025-01-06'))
        self.assertEqual(len(result), 5)
        # US weekends/holidays are expected gaps, not missing sessions.
        stocks = history(3)
        stocks.index = pd.to_datetime(['2025-07-02', '2025-07-03', '2025-07-07'])
        self.assertEqual(len(consecutive_history(stocks, 'NYSE')), 3)

    @patch('forecast.yf.Ticker')
    def test_effective_volume_sampling_and_input_archive_match_inference(self, ticker):
        ticker.return_value.history.return_value = history(210)
        ticker.return_value.get_history_metadata.return_value = {'instrumentType': 'CRYPTOCURRENCY', 'currency': 'USD'}
        class Predictor:
            device = 'cpu'
            def predict(self, **kwargs):
                self.kwargs = kwargs
                return persistence(kwargs['df'], kwargs['y_timestamp'])
        predictor = Predictor()
        engine = Forecaster()
        request = {**self.request(), 'ticker': 'BTC-USD', 'model': 'mini', 'end': '2025-07-29',
                   'method': 'paper', 'lookback': 40, 'temperature': .6, 'topP': .9, 'sampleCount': 10,
                   'seedMode': 'reproducible', 'volumeMode': 'auto'}
        with patch.object(engine, 'load_model', return_value=predictor):
            result = engine.run(request, lambda _: None)
            self.assertTrue((predictor.kwargs['df']['volume'] == 0).all())
            self.assertEqual(predictor.kwargs['T'], .6)
            self.assertEqual(predictor.kwargs['sample_count'], 10)
            self.assertEqual(result['inputHistory'][0]['volume'], 0)
            self.assertEqual(result['history'][0]['volume'], 1000)
            self.assertFalse(result['methodology']['volumeIncluded'])
            self.assertEqual(len(result['provenance']['inputSha256']), 64)
            included = engine.run({**request, 'volumeMode': 'include'}, lambda _: None)
            self.assertTrue((predictor.kwargs['df']['volume'] == 1000).all())
            self.assertNotEqual(included['provenance']['inputSha256'], result['provenance']['inputSha256'])
            with self.assertRaisesRegex(ValueError, 'needs 400'):
                engine.run({**request, 'lookback': 400}, lambda _: None)


if __name__ == '__main__':
    unittest.main()
