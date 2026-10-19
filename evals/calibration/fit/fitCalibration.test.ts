import { describe, expect, it } from 'vitest';
import { CalibrationSchema } from '../../../src/process/calibration';
import { sample } from '../__fixtures__/calibrationKit';
import { fitCalibration } from './fitCalibration';

describe('fitCalibration', () => {
  it('is monotone even when the data runs the wrong way', () => {
    const fit = fitCalibration(
      [sample(1, 3), sample(1.5, 2), sample(2, 1), sample(2.5, 0.5)],
      'light',
    );
    const ys = fit.points.map((p) => p.calibrated);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(fit.points.map((p) => p.raw)).toEqual([...fit.points.map((p) => p.raw)].sort());
  });

  it('pools violators to their mean and keeps rising data as it is', () => {
    const fit = fitCalibration([sample(1, 0), sample(2, 1), sample(3, 3)], 'light');
    expect(fit.points).toEqual([
      { raw: 1, calibrated: 0 },
      { raw: 2, calibrated: 1 },
      { raw: 3, calibrated: 3 },
    ]);
    const pooled = fitCalibration([sample(1, 2), sample(2, 0)], 'light');
    expect(pooled.points).toEqual([{ raw: 1.5, calibrated: 1 }]);
  });

  it('groups equal raw scores', () => {
    const fit = fitCalibration([sample(1, 0), sample(1, 2), sample(2, 3)], 'light');
    expect(fit.points).toEqual([
      { raw: 1, calibrated: 1 },
      { raw: 2, calibrated: 3 },
    ]);
  });

  it('shrinks the area bias toward zero and ignores areas without data', () => {
    const many = Array.from({ length: 20 }, () => sample(2, 3, 'Big'));
    const one = [sample(2, 3, 'Small')];
    const fit = fitCalibration([...many, ...one, sample(1, 0, 'other')], 'light');
    expect(Math.abs(fit.areaBias['small'] ?? 0)).toBeLessThan(
      Math.abs(fit.areaBias['big'] ?? 1) + 1,
    );
    expect(Object.keys(fit.areaBias)).toContain('big');
  });

  it('refuses to fit nothing', () => {
    expect(() => fitCalibration([], 'light')).toThrow(/no samples/i);
  });

  it('gives the version, the profile, the knots and a shrunk bias per area', () => {
    // One knot at raw 1 with target 1.5; area a is 0.5 under it, area b 0.5 over, one sample each.
    const fit = fitCalibration([sample(1, 1, 'a'), sample(1, 2, 'b')], 'fast');

    expect(fit.version).toBe(1);
    expect(fit.profile).toBe('fast');
    expect(fit.points).toEqual([{ raw: 1, calibrated: 1.5 }]);
    expect(fit.areaBias['a']).toBeCloseTo(-1 / 12, 10);
    expect(fit.areaBias['b']).toBeCloseTo(1 / 12, 10);
  });

  it('writes a file the calibration schema accepts', () => {
    const fit = fitCalibration([sample(1, 3), sample(1.5, 2), sample(2, 1)], 'light');

    expect(CalibrationSchema.safeParse(fit).success).toBe(true);
  });
});
