import { describe, expect, it } from 'vitest';
import { keepCalibration } from './keepCalibration';

describe('keepCalibration', () => {
  const m = (recall: number, leaks: number) => ({ recall, leaks, withinOne: 0.5 });

  it('keeps only when recall rises and leaks do not', () => {
    expect(keepCalibration(m(1, 1), m(1.5, 1))).toBe(true);
    expect(keepCalibration(m(1, 1), m(1.5, 2))).toBe(false);
    expect(keepCalibration(m(1, 1), m(1, 1))).toBe(false);
    expect(keepCalibration(m(1, 1), m(0.5, 0))).toBe(false);
  });

  it('keeps when recall rises and leaks fall', () => {
    expect(keepCalibration(m(1, 1), m(2, 0))).toBe(true);
  });

  it('ignores within-one accuracy', () => {
    const worse = { recall: 2, leaks: 0, withinOne: 0 };

    expect(keepCalibration({ recall: 1, leaks: 0, withinOne: 1 }, worse)).toBe(true);
  });
});
