// weekProblemLines: the weeks of a format or link measurement that did not pass.
import { describe, expect, it } from 'vitest';
import type { MetricResult, WeekDetail } from '../../../../evals/schema';
import { MAX_PROBLEMS_SHOWN, weekProblemLines } from './weekProblems';

function metricWith(label: string, byWeek?: Record<string, WeekDetail>): MetricResult {
  return {
    id: 'format',
    label,
    unit: 'ratio',
    value: 0,
    gate: { kind: 'none' },
    pass: null,
    ...(byWeek ? { byWeek } : {}),
  };
}

const failed = (problems: string[], problemCount = problems.length): WeekDetail => ({
  status: 'failed',
  problems,
  problemCount,
});

describe('weekProblemLines', () => {
  it('prints nothing for a metric without per-week detail', () => {
    expect(weekProblemLines([metricWith('Format')])).toEqual([]);
  });

  it('leaves out the weeks that passed', () => {
    const ok: WeekDetail = { status: 'ok', problems: [], problemCount: 0 };
    expect(weekProblemLines([metricWith('Format', { '2026-W36': ok })])).toEqual([]);
  });

  it('names a week with no digest and prints no problem under it', () => {
    const noDigest: WeekDetail = { status: 'no-digest', problems: [], problemCount: 0 };
    expect(weekProblemLines([metricWith('Format', { '2026-W38': noDigest })])).toEqual([
      '  Format 2026-W38: no digest',
    ]);
  });

  it('names a failed week with its problem count and the problems', () => {
    expect(weekProblemLines([metricWith('Format', { '2026-W37': failed(['a', 'b']) })])).toEqual([
      '  Format 2026-W37: failed, 2 problems',
      '    - a',
      '    - b',
    ]);
  });

  it('says "1 problem" for one problem', () => {
    const [heading] = weekProblemLines([metricWith('Format', { '2026-W37': failed(['a']) })]);
    expect(heading).toBe('  Format 2026-W37: failed, 1 problem');
  });

  it('shows at most the first few problems', () => {
    const problems = ['p1', 'p2', 'p3', 'p4'];
    const lines = weekProblemLines([metricWith('Format', { '2026-W37': failed(problems) })]);
    expect(MAX_PROBLEMS_SHOWN).toBe(3);
    expect(lines.filter((line) => line.startsWith('    - '))).toEqual([
      '    - p1',
      '    - p2',
      '    - p3',
    ]);
    expect(lines.at(-1)).toBe('    ... 1 more in the scorecard file');
  });

  it('says how many the file holds when it kept fewer than were found', () => {
    const detail = failed(['p1', 'p2', 'p3', 'p4', 'p5'], 7);
    const lines = weekProblemLines([metricWith('Format', { '2026-W37': detail })]);
    expect(lines.at(-1)).toBe('    ... 4 more (the scorecard file lists the first 5 of 7)');
  });

  it('counts the stored problems when the count says fewer', () => {
    const detail = failed(['p1', 'p2', 'p3', 'p4'], 1);
    const lines = weekProblemLines([metricWith('Format', { '2026-W37': detail })]);
    expect(lines.at(-1)).toBe('    ... 1 more in the scorecard file');
  });

  it('prints a failed week with an empty problem list as the heading alone', () => {
    expect(weekProblemLines([metricWith('Format', { '2026-W41': failed([]) })])).toEqual([
      '  Format 2026-W41: failed',
    ]);
  });

  it('prints each problem as one clean line cut to the limit', () => {
    const lines = weekProblemLines([
      metricWith('Format', { '2026-W41': failed([`bad\n\u{1b}[31m${'x'.repeat(200)}`]) }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^ {4}- bad \[31mx+\.\.\.$/);
    expect(lines[1]?.length).toBe('    - '.length + 120);
  });

  it('goes metric by metric, week by week, in the order given', () => {
    const lines = weekProblemLines([
      metricWith('Format', { '2026-W36': failed(['f1']), '2026-W37': failed(['f2']) }),
      metricWith('Link validity', { '2026-W36': failed(['l1']) }),
    ]);
    expect(lines.filter((line) => !line.startsWith('    '))).toEqual([
      '  Format 2026-W36: failed, 1 problem',
      '  Format 2026-W37: failed, 1 problem',
      '  Link validity 2026-W36: failed, 1 problem',
    ]);
  });
});
