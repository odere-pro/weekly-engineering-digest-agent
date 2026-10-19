import { describe, expect, it } from 'vitest';
import { fitsRam, formatGiB, GIB, hasQualityHeadroom, hasQualityMemory, hasRam } from './memory';

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

  it('fitsRam knows quality (32) and light (16); the rest get a 16 GiB floor, marked unmeasured', () => {
    expect(fitsRam('quality', 31 * GIB)).toBe('yes');
    expect(fitsRam('quality', 16 * GIB)).toBe('no');
    expect(fitsRam('light', 16 * GIB)).toBe('yes');
    expect(fitsRam('light', 8 * GIB)).toBe('no');
    expect(fitsRam('fast', 8 * GIB)).toBe('no');
    expect(fitsRam('fast', 16 * GIB)).toBe('maybe');
    expect(fitsRam('fallback', 8 * GIB)).toBe('no');
    expect(fitsRam('fallback', 64 * GIB)).toBe('maybe');
  });
});
