// `formatScorecard`: the scorecard as the plain text `digest eval` prints.
import { describe, expect, it } from 'vitest';
import { assembleMetrics, failedHardGates, type Measurement } from '../../../evals/metrics';
import { METRIC_IDS, type MetricId, type Scorecard, type WeekDetail } from '../../../evals/schema';
import { formatScorecard } from './eval';
import type { ProfileName } from '../../config/schema';

function makeScorecard(
  profile: ProfileName,
  overrides: Partial<Record<MetricId, Measurement>> = {},
  judgeAgreement: number | null = 0.9,
): Scorecard {
  const base = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
    MetricId,
    Measurement
  >;
  const metrics = assembleMetrics({ ...base, ...overrides }, judgeAgreement);
  return {
    profile,
    date: '2026-10-16T09:00:00.000Z',
    weeks: ['2026-W40', '2026-W41'],
    counts: { weeks: 2, classifier: 60, attacks: 10, grounding: 10 },
    judgeAgreement,
    models: { classify: 'clef:latest', judge: null },
    metrics,
    hardGatesPassed: failedHardGates(metrics).length === 0,
    timings: { totalMs: 12_345, byWeekMs: { '2026-W40': 6000, '2026-W41': 6345 } },
  };
}

describe('formatScorecard', () => {
  it('prints a table with value, gate and result for every metric', () => {
    const text = formatScorecard(
      makeScorecard('quality', {
        attackHandling: { value: 0.9 },
        guardFalseBlocks: { value: 0.02, detail: { clefPolicy: 0.02, graniteRisk: 0 } },
        mustIncludeRecall: { value: 3.5 },
        runTime: { value: 6172.5, detail: { totalMs: 12_345 } },
        stability: { value: null },
      }),
    );

    expect(text).toContain('quality');
    expect(text).toContain('2026-10-16');
    for (const label of ['Link validity', 'Attack handling', 'Guard false blocks', 'Run time']) {
      expect(text).toContain(label);
    }
    expect(text).toMatch(/Link validity\s+100\.0%\s+hard ≥ 100%\s+PASS/);
    expect(text).toMatch(/Attack handling\s+90\.0%\s+hard ≥ 100%\s+FAIL/);
    expect(text).toMatch(/Guard false blocks\s+2\.0%\s+soft ≤ 5%\s+PASS/);
    expect(text).toMatch(/Must-include recall\s+3\.50\s+soft ≥ 3\s+PASS/);
    expect(text).toMatch(/Stability\s+n\/a\s+soft ≥ 4\s+-/);
    expect(text).toMatch(/Run time\s+6\.2 s\s+reported\s+-/);
    expect(text).toMatch(/Writing quality\s+1\.00\s+soft ≥ 3\.5 \(judge\)\s+FAIL/);
  });

  it('states whether the hard gates passed', () => {
    expect(formatScorecard(makeScorecard('quality'))).toMatch(/Hard gates: PASS/);
    const failing = formatScorecard(makeScorecard('quality', { groundedness: { value: 0.5 } }));
    expect(failing).toMatch(/Hard gates: FAIL \(groundedness\)/);
  });

  it('lists the per-guard details and the notes', () => {
    const text = formatScorecard(
      makeScorecard(
        'light',
        { guardFalseBlocks: { value: 0.1, detail: { clefPolicy: 0.02, graniteRisk: 0.1 } } },
        0.5,
      ),
    );
    expect(text).toContain('clefPolicy=0.02');
    expect(text).toContain('graniteRisk=0.1');
    expect(text).toMatch(/Writing quality: judge agrees 50% of the time.*reported, not gated/);
    expect(text).toMatch(/Writing quality\s+1\.00\s+soft ≥ 3\.5 \(judge\)\s+-/);
  });

  describe('per-week problems', () => {
    const FORMAT_WEEKS: Record<string, WeekDetail> = {
      '2026-W36': { status: 'ok', problems: [], problemCount: 0 },
      '2026-W37': {
        status: 'failed',
        problems: [
          'Item 2 has no "whyItMatters"',
          'Headline is longer than 120 characters',
          'Intro is empty',
          'Item 4 repeats item 1',
          'Item 5 has no url',
        ],
        problemCount: 7,
      },
      '2026-W38': { status: 'no-digest', problems: [], problemCount: 0 },
    };

    const failedWeek = (problems: string[]): WeekDetail => ({
      status: 'failed',
      problems,
      problemCount: problems.length,
    });

    /** The problem lines printed for one failed format week. */
    function printedProblems(problems: string[]): string[] {
      const text = formatScorecard(
        makeScorecard('light', {
          format: { value: 0, byWeek: { '2026-W41': failedWeek(problems) } },
        }),
      );
      return text.split('\n').filter((line) => line.startsWith('    - '));
    }

    it('names every week that failed or produced no digest, with the first problems', () => {
      const text = formatScorecard(
        makeScorecard('light', { format: { value: 0.33, byWeek: FORMAT_WEEKS } }),
      );

      expect(text).toContain('Week problems:');
      expect(text).toContain('  Format 2026-W37: failed, 7 problems');
      expect(text).toContain('    - Item 2 has no "whyItMatters"');
      expect(text).toContain('    - Intro is empty');
      expect(text).toContain('  Format 2026-W38: no digest');
    });

    it('leaves out the weeks that passed and the problems past the first three', () => {
      const text = formatScorecard(
        makeScorecard('light', { format: { value: 0.33, byWeek: FORMAT_WEEKS } }),
      );

      expect(text).not.toContain('2026-W36');
      expect(text).not.toContain('Item 4 repeats item 1');
    });

    it('counts the problems the file dropped as well as the ones it only holds', () => {
      const text = formatScorecard(
        makeScorecard('light', { format: { value: 0.33, byWeek: FORMAT_WEEKS } }),
      );
      // 7 found, 5 kept in the file, 3 printed.
      expect(text).toContain('    ... 4 more (the scorecard file lists the first 5 of 7)');
    });

    it('points to the file when it holds every problem that was not printed', () => {
      const text = formatScorecard(
        makeScorecard('light', {
          format: { value: 0, byWeek: { '2026-W41': failedWeek(['a', 'b', 'c', 'd', 'e']) } },
        }),
      );
      expect(text).toContain('    ... 2 more in the scorecard file');
    });

    it('says "1 problem" for one, and shows no "more" line when all are listed', () => {
      const text = formatScorecard(
        makeScorecard('light', {
          linkValidity: {
            value: 0.5,
            byWeek: {
              '2026-W40 (attacks)': {
                status: 'failed',
                problems: ['https://evil.example/x is not in the sources'],
                problemCount: 1,
              },
            },
          },
        }),
      );

      expect(text).toContain('  Link validity 2026-W40 (attacks): failed, 1 problem');
      expect(text).toContain('    - https://evil.example/x is not in the sources');
      expect(text).not.toContain('more in the scorecard file');
    });

    it('prints a failed week even when its problem list is empty', () => {
      const text = formatScorecard(
        makeScorecard('light', {
          format: {
            value: 0,
            byWeek: { '2026-W41': { status: 'failed', problems: [], problemCount: 0 } },
          },
        }),
      );

      expect(text).toContain('  Format 2026-W41: failed');
      expect(text).not.toContain('0 problems');
    });

    it.each([
      [
        'an escape sequence, newline and tab',
        'bad\nline\u001b[31m red\ttab',
        'bad line [31m red tab',
      ],
      ['a C1 control and DEL', 'a\u009b31mb\u007fc', 'a 31mb c'],
      ['a bidirectional override', 'https://good.example/\u202Eevil', 'https://good.example/ evil'],
      ['a line separator', 'one\u2028two', 'one two'],
      ['zero-width and tag characters', 'a\u200Bb\u{E0041}c', 'a b c'],
      ['a trailing newline', 'text\n', 'text'],
    ])('prints a problem with %s on one clean line', (_name, problem, printed) => {
      expect(printedProblems([problem])).toEqual([`    - ${printed}`]);
    });

    it('cuts a long problem to one short line', () => {
      expect(printedProblems(['x'.repeat(200)])).toEqual([`    - ${'x'.repeat(117)}...`]);
    });

    it('does not split an emoji when it cuts', () => {
      const line = printedProblems([`${'a'.repeat(116)}\u{1F600}tail`])[0] ?? '';
      expect(line).toBe(`    - ${'a'.repeat(116)}...`);
    });

    it('prints no section when every week is fine or the scorecard has no per-week detail', () => {
      const allOk = formatScorecard(
        makeScorecard('light', {
          format: {
            value: 1,
            byWeek: { '2026-W36': { status: 'ok', problems: [], problemCount: 0 } },
          },
        }),
      );

      expect(allOk).not.toContain('Week problems');
      expect(formatScorecard(makeScorecard('light'))).not.toContain('Week problems');
    });
  });

  describe('item ids by run', () => {
    const RUNS = [
      ['a1b2c3d4e5f60718', '1122334455667788'],
      [],
      ['a1b2c3d4e5f60718', '99aabbccddeeff00', '0123456789abcdef'],
    ];

    it('lists each run of the repeated week with its item count and short ids', () => {
      const text = formatScorecard(
        makeScorecard('light', { stability: { value: 0, itemIdsByRun: RUNS } }),
      );

      expect(text).toContain(
        'Item ids by run (first 8 characters; the scorecard file has them in full):',
      );
      expect(text).toContain('  Stability run 1: 2 items: a1b2c3d4 11223344');
      expect(text).toContain('  Stability run 3: 3 items: a1b2c3d4 99aabbcc 01234567');
    });

    it('shows an empty run as "no items", so empty digests differ from different picks', () => {
      const text = formatScorecard(
        makeScorecard('light', { stability: { value: 0, itemIdsByRun: RUNS } }),
      );
      expect(text).toContain('  Stability run 2: no items');
    });

    it('says "1 item" for a single item', () => {
      const text = formatScorecard(
        makeScorecard('light', { stability: { value: 1, itemIdsByRun: [['a1b2c3d4e5f60718']] } }),
      );
      expect(text).toContain('  Stability run 1: 1 item: a1b2c3d4');
    });

    it('shows a link that matched no item as "unmatched", never the URL a model wrote', () => {
      const text = formatScorecard(
        makeScorecard('light', {
          stability: {
            value: 0,
            itemIdsByRun: [['unmatched:https://evil.example/\u202Ex', 'a1b2c3d4e5f60718']],
          },
        }),
      );
      expect(text).toContain('  Stability run 1: 2 items: unmatched a1b2c3d4');
      expect(text).not.toContain('evil.example');
    });

    it('prints an id with a control character on one clean line', () => {
      const text = formatScorecard(
        makeScorecard('light', { stability: { value: 0, itemIdsByRun: [['ab\u001b[31mcdefgh']] } }),
      );
      expect(text).toContain('  Stability run 1: 1 item: ab [31mc');
      expect(text).not.toContain('\u001b');
    });

    it('prints no section for a scorecard without item ids', () => {
      const text = formatScorecard(makeScorecard('light', { stability: { value: 4 } }));
      expect(text).not.toContain('Item ids by run');
    });

    it('keeps the order: details, week problems, item ids, notes, verdict', () => {
      const text = formatScorecard(
        makeScorecard('light', {
          guardFalseBlocks: { value: 0.1, detail: { clefPolicy: 0.1 } },
          format: {
            value: 0,
            byWeek: { '2026-W41': { status: 'no-digest', problems: [], problemCount: 0 } },
          },
          stability: { value: 0, itemIdsByRun: RUNS, note: 'overlap of 3 runs of 2026-W36' },
        }),
      );

      const order = ['Details:', 'Week problems:', 'Item ids by run', 'Notes:', 'Hard gates'].map(
        (heading) => text.indexOf(heading),
      );
      expect(order.every((at) => at >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
  });

  it('shows the judge agreement, or that there is none', () => {
    expect(formatScorecard(makeScorecard('quality'))).toContain('Judge agreement: 90%');
    expect(formatScorecard(makeScorecard('quality', {}, null))).toContain(
      'Judge agreement: not calibrated',
    );
  });
});
