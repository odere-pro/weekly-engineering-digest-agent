import { describe, expect, it } from 'vitest';
import { parseCli, USAGE } from './parseCli';

const base = ['--profile', 'light', '--flag', 'on'];

describe('parseCli', () => {
  it('reads the profile, the flag and leaves the rest at their defaults', () => {
    expect(parseCli(base)).toEqual({
      ok: true,
      profile: 'light',
      flag: true,
      config: undefined,
      calibration: undefined,
      holdout: undefined,
      pairwise: false,
    });
  });

  it('reads every option', () => {
    const parsed = parseCli([
      '--profile',
      'fast',
      '--flag',
      'off',
      '--config',
      'my.json',
      '--calibration',
      'c.json',
      '--holdout',
      '2026-W40,2026-W41',
      '--pairwise',
      'on',
    ]);

    expect(parsed).toEqual({
      ok: true,
      profile: 'fast',
      flag: false,
      config: 'my.json',
      calibration: 'c.json',
      holdout: ['2026-W40', '2026-W41'],
      pairwise: true,
    });
  });

  it('reads --pairwise off as false', () => {
    expect(parseCli([...base, '--pairwise', 'off'])).toMatchObject({ ok: true, pairwise: false });
  });

  it.each([
    [[], 'unknown or missing --profile'],
    [['--profile', 'nope', '--flag', 'on'], 'unknown or missing --profile'],
    [['--profile', 'light'], '--flag must be on or off'],
    [['--profile', 'light', '--flag', 'maybe'], '--flag must be on or off'],
    [[...base, '--pairwise', 'maybe'], '--pairwise must be on or off'],
  ])('rejects %j with "%s"', (args, reason) => {
    expect(parseCli(args)).toEqual({ ok: false, reason });
  });

  it('turns an unknown option into a reason, not a throw', () => {
    const parsed = parseCli([...base, '--bogus']);

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.reason).toContain('--bogus');
  });

  it('turns a bad holdout week into a reason', () => {
    expect(parseCli([...base, '--holdout', 'nope'])).toEqual({
      ok: false,
      reason: '--holdout: "nope" is not a week id like 2026-W40',
    });
  });
});

describe('USAGE', () => {
  it('names the command and every option, and ends with a newline', () => {
    for (const option of [
      '--profile',
      '--flag',
      '--config',
      '--calibration',
      '--holdout',
      '--pairwise',
    ])
      expect(USAGE).toContain(option);
    expect(USAGE.startsWith('Usage: tsx evals/rescoreReplay.ts')).toBe(true);
    expect(USAGE.endsWith('\n')).toBe(true);
  });
});
