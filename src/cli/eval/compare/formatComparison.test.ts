// formatComparison: the text `digest eval --compare` prints for two saved scorecards.
import { describe, expect, it } from 'vitest';
import { compareScorecards } from '../../../../evals/compare';
import type { Measurement } from '../../../../evals/metrics/measurement/measurement';
import type { MetricId } from '../../../../evals/schema';
import type { SavedScorecard } from '../../../../evals/checkpointSections';
import { makeScorecard } from '../__fixtures__/scorecardKit';
import { formatComparison } from './formatComparison';

const FILES = { before: 'a.json', after: 'b.json' };

function card(
  overrides: Partial<Record<MetricId, Measurement>> = {},
  extra: Partial<SavedScorecard> = {},
): SavedScorecard {
  return { ...makeScorecard('light', overrides), ...extra };
}

function compared(before: SavedScorecard, after: SavedScorecard): string {
  return formatComparison(compareScorecards(before, after), FILES);
}

/** The printed line of one metric, found by its label. */
function lineOf(text: string, label: string): string {
  const line = text.split('\n').find((candidate) => candidate.startsWith(label));
  if (line === undefined) throw new Error(`no line for ${label} in:\n${text}`);
  return line;
}

describe('formatComparison: header', () => {
  it('names both files with their profile and day', () => {
    const text = compared(
      card({}, { profile: 'light', date: '2026-10-10T09:00:00.000Z' }),
      card({}, { profile: 'fast', date: '2026-10-18T09:00:00.000Z' }),
    );

    expect(text).toContain('Eval compare: A = a.json (light, 2026-10-10)');
    expect(text).toContain('B = b.json (fast, 2026-10-18)');
  });

  it('notes a partial scorecard on either side, and only then', () => {
    const partial = card({}, { partial: ['guards'] });

    expect(compared(partial, card())).toContain('A partial scorecard has "n/a"');
    expect(compared(card(), partial)).toContain('A partial scorecard has "n/a"');
    expect(compared(card(), card())).not.toContain('A partial scorecard');
  });
});

describe('formatComparison: metric table', () => {
  it('prints every metric with both values, the delta, the gate of B and the result change', () => {
    const text = compared(
      card({ classifierAccuracy: { value: 0.7 } }),
      card({ classifierAccuracy: { value: 0.85 } }),
    );

    expect(text).toMatch(/^Metric\s+A\s+B\s+Delta\s+Gate \(B\)\s+Result A -> B$/m);
    expect(lineOf(text, 'Classifier accuracy')).toMatch(
      /Classifier accuracy\s+70\.0%\s+85\.0%\s+\+15\.0 pt\s+soft ≥ 80%\s+FAIL -> PASS/,
    );
  });

  it('prints the result alone when it did not change', () => {
    const line = lineOf(compared(card(), card()), 'Link validity');
    expect(line).toMatch(/Link validity\s+100\.0%\s+100\.0%\s+0\.0 pt\s+hard ≥ 100%\s+PASS$/);
  });

  it('shows a drop as a negative delta and a hard gate that now fails', () => {
    const line = lineOf(compared(card(), card({ linkValidity: { value: 0.5 } })), 'Link validity');
    expect(line).toMatch(/50\.0%\s+-50\.0 pt\s+hard ≥ 100%\s+PASS -> FAIL$/);
  });

  it('prints a time delta in seconds', () => {
    const text = compared(card({ runTime: { value: 6000 } }), card({ runTime: { value: 8500 } }));
    expect(lineOf(text, 'Run time')).toMatch(/6\.0 s\s+8\.5 s\s+\+2\.5 s/);
  });

  it('prints a count or score delta with two decimals', () => {
    const text = compared(
      card({ mustIncludeRecall: { value: 3 }, writingQuality: { value: 4 } }),
      card({ mustIncludeRecall: { value: 3.5 }, writingQuality: { value: 3.5 } }),
    );
    expect(lineOf(text, 'Must-include recall')).toMatch(/3\.00\s+3\.50\s+\+0\.50/);
    expect(lineOf(text, 'Writing quality')).toMatch(/4\.00\s+3\.50\s+-0\.50/);
  });

  it('prints n/a for a metric one side did not measure', () => {
    const text = compared(card({ stability: { value: null } }), card({ stability: { value: 4 } }));
    expect(lineOf(text, 'Stability')).toMatch(/Stability\s+n\/a\s+4\.00\s+n\/a/);
  });
});

describe('formatComparison: weeks', () => {
  const week = (status: 'ok' | 'failed'): Measurement => ({
    value: 1,
    byWeek: {
      '2026-W40': { status, problems: [], problemCount: status === 'ok' ? 0 : 1 },
    },
  });

  it('says so when no week changed status', () => {
    const text = compared(card({ format: week('ok') }), card({ format: week('ok') }));
    expect(text).toContain('Weeks: no week changed status.');
    expect(text).not.toContain('Weeks that changed status');
  });

  it('lists the weeks whose status changed, with before and after', () => {
    const text = compared(card({ format: week('failed') }), card({ format: week('ok') }));

    expect(text).toContain('Weeks that changed status:');
    expect(text).toMatch(/Metric\s+Week\s+Before\s+After/);
    expect(text).toMatch(/Format\s+2026-W40\s+failed\s+ok/);
  });
});
