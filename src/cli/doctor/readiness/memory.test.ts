import { describe, expect, it } from 'vitest';
import {
  fitsRam,
  formatGiB,
  GIB,
  hasQualityHeadroom,
  hasQualityMemory,
  hasRam,
  QUALITY_TIGHT_RAM,
} from './memory';

describe('RAM helpers', () => {
  it('hasRam allows a 5% tolerance below the figure', () => {
    expect(hasRam(32 * GIB * 0.95, 32)).toBe(true);
    expect(hasRam(32 * GIB * 0.95 - 1, 32)).toBe(false);
  });

  it('hasQualityMemory is hasRam for 32 GiB', () => {
    expect(hasQualityMemory(32 * GIB)).toBe(true);
    expect(hasQualityMemory(16 * GIB)).toBe(false);
  });

  it('hasQualityMemory accepts a "32 GB" Linux box that reports about 31 GiB', () => {
    expect(hasQualityMemory(31 * GIB)).toBe(true);
    expect(hasQualityMemory(30 * GIB)).toBe(false);
  });

  it('hasQualityHeadroom needs 48 GiB: quality swapped on a 32 GiB Mac (measured 2026-10-19)', () => {
    expect(hasQualityHeadroom(48 * GIB)).toBe(true);
    expect(hasQualityHeadroom(64 * GIB)).toBe(true);
    expect(hasQualityHeadroom(32 * GIB)).toBe(false);
  });

  it('hasQualityHeadroom allows the same 5% tolerance as the other figures', () => {
    expect(hasQualityHeadroom(48 * GIB * 0.95)).toBe(true);
    expect(hasQualityHeadroom(48 * GIB * 0.95 - 1)).toBe(false);
  });

  it('formatGiB prints one decimal', () => {
    expect(formatGiB(1.5 * GIB)).toBe('1.5 GiB');
    expect(formatGiB(0)).toBe('0.0 GiB');
  });

  it('fitsRam knows light (16); the rest get a 16 GiB floor, marked unmeasured', () => {
    expect(fitsRam('light', 16 * GIB)).toBe('yes');
    expect(fitsRam('light', 8 * GIB)).toBe('no');
    expect(fitsRam('fast', 8 * GIB)).toBe('no');
    expect(fitsRam('fast', 16 * GIB)).toBe('maybe');
    expect(fitsRam('fast', 32 * GIB)).toBe('maybe');
    expect(fitsRam('fallback', 8 * GIB)).toBe('no');
    expect(fitsRam('fallback', 64 * GIB)).toBe('maybe');
  });

  it.each([
    [64, 'yes'],
    [48, 'yes'],
    [45.7, 'yes'],
    [45.5, 'tight'],
    [32, 'tight'],
    [31, 'tight'],
    [30.4, 'tight'],
    [30.3, 'no'],
    [16, 'no'],
  ] as const)('fitsRam says quality at %d GiB of RAM is %s', (ramGiB, fit) => {
    expect(fitsRam('quality', ramGiB * GIB)).toBe(fit);
  });

  it('fitsRam agrees with hasQualityMemory and hasQualityHeadroom at every size', () => {
    for (let ramGiB = 0; ramGiB <= 80; ramGiB += 0.5) {
      const bytes = ramGiB * GIB;
      const expected = hasQualityHeadroom(bytes) ? 'yes' : hasQualityMemory(bytes) ? 'tight' : 'no';
      expect(fitsRam('quality', bytes)).toBe(expected);
    }
  });
});

describe('QUALITY_TIGHT_RAM', () => {
  it('quotes what was measured on the reference laptop (2026-10-19)', () => {
    expect(QUALITY_TIGHT_RAM).toMatch(/M1 Pro/);
    expect(QUALITY_TIGHT_RAM).toMatch(/input guard alone took about 1 h/);
    expect(QUALITY_TIGHT_RAM).toMatch(/8 of 9 GB of swap/);
    expect(QUALITY_TIGHT_RAM).toMatch(/light needs 16 GB and took about 6 min for a whole week/);
  });
});
