import { describe, expect, it } from 'vitest';
import { calculateBinaryMetrics } from '../../src/calibration/metrics.js';

describe('calibration binary metrics', () => {
  it('counts the confusion matrix and excludes abstentions', () => {
    const m = calculateBinaryMetrics([
      { expected: true, observed: true },
      { expected: true, observed: false },
      { expected: false, observed: true },
      { expected: false, observed: false },
      { expected: null, observed: true },
      { expected: true, observed: null },
    ]);
    expect(m).toEqual({
      total: 6,
      decided: 4,
      abstentions: 2,
      tp: 1,
      fp: 1,
      tn: 1,
      fn: 1,
      precision: 0.5,
      recall: 0.5,
      specificity: 0.5,
      false_positive_rate: 0.5,
      false_negative_rate: 0.5,
      accuracy: 0.5,
      abstention_rate: 1 / 3,
      coverage: 2 / 3,
    });
  });

  it('uses null for every zero denominator and never emits a misleading zero', () => {
    const m = calculateBinaryMetrics([{ expected: true, observed: true }]);
    expect(m).toMatchObject({
      tp: 1,
      fp: 0,
      tn: 0,
      fn: 0,
      precision: 1,
      recall: 1,
      specificity: null,
      false_positive_rate: null,
      false_negative_rate: 0,
      accuracy: 1,
    });
    expect(Object.values(m).every((x) => typeof x !== 'number' || Number.isFinite(x))).toBe(true);
  });

  it('maintains accounting invariants on a property-style bounded table', () => {
    const values: Array<boolean | null> = [true, false, null];
    for (const expected of values)
      for (const observed of values)
        for (const secondExpected of values) {
          const m = calculateBinaryMetrics([
            { expected, observed },
            { expected: secondExpected, observed: false },
          ]);
          expect(m.abstentions + m.decided).toBe(m.total);
          expect(m.tp + m.fn).toBeLessThanOrEqual(2);
          expect(m.tn + m.fp).toBeLessThanOrEqual(2);
          for (const key of [
            'precision',
            'recall',
            'specificity',
            'false_positive_rate',
            'false_negative_rate',
            'accuracy',
            'abstention_rate',
            'coverage',
          ] as const) {
            const value = m[key];
            expect(value === null || (value >= 0 && value <= 1)).toBe(true);
          }
        }
  });
});
