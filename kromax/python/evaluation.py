"""Chronological configuration selection with a separate, later audit."""
import json
from pathlib import Path

import numpy as np
import pandas as pd

CATALOG = json.loads((Path(__file__).resolve().parents[1] / 'forecast-methods.json').read_text())
PRICE_COLUMNS = ['open', 'high', 'low', 'close']


def persistence(context, dates):
    last = context.iloc[-1]
    return pd.DataFrame({**{column: float(last['close']) for column in PRICE_COLUMNS},
                         'volume': float(last['volume'])}, index=pd.DatetimeIndex(dates))


def score(prediction, actual, context, objective):
    if len(prediction) != len(actual) or not prediction.index.equals(actual.index):
        raise ValueError('Prediction dates must match the validation target dates exactly.')
    predicted = prediction[PRICE_COLUMNS].to_numpy(dtype=float)
    truth = actual[PRICE_COLUMNS].to_numpy(dtype=float)
    anchor = float(context['close'].iloc[-1])
    errors = predicted - truth
    baseline_errors = anchor - truth
    columns = [3] if objective == 'close_mae' else [0, 1, 2, 3]
    return {
        'closeMAE': float(np.abs(errors[:, 3]).mean()),
        'closeRMSE': float(np.sqrt(np.square(errors[:, 3]).mean())),
        'closeMAPEPercent': float((np.abs(errors[:, 3]) / truth[:, 3]).mean() * 100),
        'ohlcMAE': float(np.abs(errors).mean()),
        'objectiveMAE': float(np.abs(errors[:, columns]).mean()),
        'baselineMAE': float(np.abs(baseline_errors[:, columns]).mean()),
        'endpointDirectionAccuracyPercent': float(np.sign(predicted[-1, 3] - anchor) == np.sign(truth[-1, 3] - anchor)) * 100,
    }


def summarize(folds):
    metrics = {key: float(np.mean([fold['metrics'][key] for fold in folds])) for key in folds[0]['metrics']}
    metrics['closeRMSE'] = float(np.sqrt(np.mean([fold['metrics']['closeRMSE'] ** 2 for fold in folds])))
    metrics['skillPercent'] = (1 - metrics['objectiveMAE'] / metrics['baselineMAE']) * 100 if metrics['baselineMAE'] > 0 else None
    metrics['windows'] = len(folds)
    return metrics


def plan_windows(length, horizon, tuning_windows, minimum_context=180):
    first = length - (tuning_windows + 2) * horizon
    if first < minimum_context:
        needed = minimum_context + (tuning_windows + 2) * horizon
        raise ValueError(f'Asset validation needs at least {needed} consecutive completed candles for this horizon. Expand the historical range or reduce the horizon/windows.')
    return [(start, start + horizon) for start in range(first, length, horizon)]


def select_configuration(frame, request, predict, progress, serialize):
    windows = plan_windows(len(frame), request['horizon'], request['validationWindows'])
    if frame.index[windows[0][0]] < pd.Timestamp('2024-07-01'):
        raise ValueError('Validation targets must be after June 2024, the paper\'s stated pretraining cutoff. Choose a more recent end date.')
    tuning = windows[:-2]

    def evaluate(candidate, intervals, offset, label):
        folds = []
        for index, (start, stop) in enumerate(intervals):
            context = frame.iloc[start - candidate['lookback']:start]
            actual = frame.iloc[start:stop]
            seed = (request['seed'] + offset + index) % 2147483648
            progress(f'{label}: {candidate["id"]}, window {index + 1}/{len(intervals)}…')
            predicted = predict(context, actual.index, candidate, seed)
            folds.append({
                'origin': context.index[-1].strftime('%Y-%m-%d'),
                'start': actual.index[0].strftime('%Y-%m-%d'),
                'end': actual.index[-1].strftime('%Y-%m-%d'), 'seed': seed,
                'metrics': score(predicted, actual, context, request['objective']),
                'prediction': serialize(predicted), 'actual': serialize(actual),
                'baseline': serialize(persistence(context, actual.index)),
            })
        return {'metrics': summarize(folds), 'folds': folds}

    results = []
    for candidate in CATALOG['candidates']:
        try:
            results.append({'settings': candidate, 'status': 'complete', **evaluate(candidate, tuning, 0, 'Selecting settings')})
        except ValueError as error:
            results.append({'settings': candidate, 'status': 'failed', 'error': str(error)})
    eligible = [result for result in results if result['status'] == 'complete']
    if not eligible:
        raise ValueError('All candidate configurations failed validation. Try another date range or model.')
    winner = min(eligible, key=lambda result: result['metrics']['objectiveMAE'])
    # Selection is frozen before either audit window is forecast or scored.
    audit = evaluate(winner['settings'], windows[-2:], len(tuning), 'Auditing selected settings')
    use_baseline = request['fallbackToBaseline'] and audit['metrics']['objectiveMAE'] >= audit['metrics']['baselineMAE']
    return winner['settings'], {
        'method': 'chronological-selection-then-audit', 'objective': request['objective'],
        'tuningWindows': len(tuning), 'auditWindows': 2, 'horizon': request['horizon'],
        'selectedCandidate': winner['settings']['id'], 'candidates': results,
        'audit': audit, 'baselineFallback': bool(use_baseline),
        'history': serialize(frame.iloc[windows[0][0] - 180:]),
        'limitations': 'Retrospective audit on two windows, not proof of future accuracy. Checkpoint training overlap is not independently verified; vendor data may be revised.' + (' The fallback decision uses the audit, so the audit is not an unbiased score of that decision rule.' if request['fallbackToBaseline'] else ''),
    }
