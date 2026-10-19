import { describe, expect, it } from 'vitest';
import { checkedSamples, type DigestSample } from './digestSample';
import type { WeekDetail } from '../../schema';

const OK: WeekDetail = { status: 'ok', problems: [], problemCount: 0 };
const sample = (overrides: Partial<DigestSample> = {}): DigestSample => ({
  weekId: '2026-W40',
  markdown: '# digest',
  items: [],
  ...overrides,
});

describe('checkedSamples', () => {
  it('labels a sample by its week, or by its own label when it has one', () => {
    const checked = checkedSamples(
      [sample(), sample({ weekId: '2026-W41', label: '2026-W41 with attacks' })],
      () => OK,
    );

    expect(checked.map((c) => c.label)).toEqual(['2026-W40', '2026-W41 with attacks']);
  });

  it('numbers a repeated label, so no sample is lost', () => {
    const checked = checkedSamples([sample(), sample(), sample()], () => OK);

    expect(checked.map((c) => c.label)).toEqual(['2026-W40', '2026-W40 (2)', '2026-W40 (3)']);
  });

  it('checks a sample with a digest and hands the check its markdown', () => {
    const seen: string[] = [];

    const checked = checkedSamples([sample({ markdown: '# one' })], (s) => {
      seen.push(s.markdown);
      return { status: 'failed', problems: ['bad'], problemCount: 1 };
    });

    expect(seen).toEqual(['# one']);
    expect(checked[0]?.detail.status).toBe('failed');
  });

  it('does not run the check on a sample without a digest, and shows its cause', () => {
    let calls = 0;

    const checked = checkedSamples(
      [sample({ markdown: undefined, cause: 'blocked by clefRubric' })],
      () => {
        calls += 1;
        return OK;
      },
    );

    expect(calls).toBe(0);
    expect(checked[0]?.detail).toEqual({
      status: 'no-digest',
      problems: ['blocked by clefRubric'],
      problemCount: 1,
    });
  });

  it('is empty without samples', () => {
    expect(checkedSamples([], () => OK)).toEqual([]);
  });
});
