// Writing quality on a profile with no judge (F10): when the run is given an eval judge, the
// harness scores the winning digest of each replayed week with it. This runs `runEval`, so it is
// the integration test of `judgeWinners.ts` and `judgedQuality`; `judgeWinners.test.ts` has the
// unit cases.
import { describe, expect, it, vi } from 'vitest';
import type { EvalJudge } from './evalJudge';
import { runEval } from '../runEval';
import { ScorecardSchema } from '../schema';
import { PROFILES } from '../../src/config/profiles';
import type { Draft, Item } from '../../src/domain/schemas';
import type { JudgeScore } from '../../src/select/judgeScore';
import { DigestError } from '../../src/shared/errors';
import type { Logger } from '../../src/shared/telemetry';
import { noopLogger } from '../../test/fakes';
import {
  NONE,
  WEEK_40,
  WEEK_41,
  makeApp,
  makeDeps,
  useCasesDir,
  writeJson,
  writeStandardWeeks,
} from '../evalKit';

const casesDir = useCasesDir();

interface JudgeCall {
  draft: Draft;
  sources: readonly Item[];
}

/** Scores each draft with the next of `scores`, and remembers what it was asked. */
function fakeJudge(scores: readonly (number | Error)[], model = 'clef:latest') {
  const calls: JudgeCall[] = [];
  const judge: EvalJudge = {
    model,
    score: (draft, sources) => {
      const next = scores[calls.length];
      calls.push({ draft, sources });
      if (next instanceof Error) return Promise.reject(next);
      const score: JudgeScore = {
        writer: draft.writer,
        score: next ?? 3,
        byCriterion: { accuracy: next ?? 3 },
      };
      return Promise.resolve(score);
    },
  };
  return { judge, calls };
}

async function run(
  profile: 'light' | 'quality',
  scores: readonly (number | Error)[],
  fakeOptions: Parameters<typeof makeDeps>[2] = {},
  logger: Logger = noopLogger,
) {
  await writeStandardWeeks(casesDir());
  const app = makeApp({ logger }, PROFILES[profile]);
  const { judge, calls } = fakeJudge(scores);
  const deps = makeDeps(app, [], fakeOptions, { judge });
  const card = await runEval({ profile, casesDir: casesDir(), minimums: NONE }, deps);
  return { card, calls, judge };
}

describe('a profile without a judge', () => {
  it('scores the winning digest of each week and reports the mean as writing quality', async () => {
    const { card, calls } = await run('light', [4, 3]);

    expect(calls).toHaveLength(2);
    expect(card.metrics.writingQuality.value).toBe(3.5);
  });

  it('asks the judge about the winning writer, the digest as written and the week items', async () => {
    const { calls } = await run('light', [4, 3], { take: 3, winner: 'gemma' });

    const [first] = calls;
    expect(first?.draft.writer).toBe('gemma');
    expect(first?.draft.digest.weekId).toBe(WEEK_40);
    expect(first?.draft.digest.items).toHaveLength(3);
    // Every digest item resolves to a collected item of that week.
    const sourceIds = new Set(first?.sources.map((item) => item.id));
    for (const entry of first?.draft.digest.items ?? []) {
      expect(sourceIds.has(entry.itemId), entry.itemId).toBe(true);
    }
    expect(first?.sources.map((item) => item.title)).toContain(`${WEEK_40}-1`);
  });

  it('judges after every week has been replayed, so the models are not swapped in between', async () => {
    await writeStandardWeeks(casesDir());
    const order: string[] = [];
    const base = makeDeps(makeApp({}, PROFILES.light), []);
    const replay = base.runDigest;
    const judge: EvalJudge = {
      model: 'clef:latest',
      score: (draft) => {
        order.push(`judge ${draft.digest.weekId}`);
        return Promise.resolve({ writer: draft.writer, score: 4, byCriterion: {} });
      },
    };
    const deps = {
      ...base,
      judge,
      runDigest: async (...args: Parameters<typeof replay>) => {
        order.push(`replay ${args[1].weekId}`);
        return replay(...args);
      },
    };

    await runEval({ profile: 'light', casesDir: casesDir(), minimums: NONE }, deps);

    const firstJudge = order.findIndex((entry) => entry.startsWith('judge'));
    expect(order.slice(0, firstJudge).every((entry) => entry.startsWith('replay'))).toBe(true);
    expect(order.slice(firstJudge).every((entry) => entry.startsWith('judge'))).toBe(true);
    expect(order.slice(firstJudge)).toEqual([`judge ${WEEK_40}`, `judge ${WEEK_41}`]);
  });

  it('records the judge model and says the score is not gated, as the judge is not calibrated', async () => {
    const { card } = await run('light', [5, 5]);

    expect(card.models.evalJudge).toBe('clef:latest');
    expect(card.models.judge).toBeNull();
    expect(card.metrics.writingQuality.note).toBe(
      'scored by clef:latest inside the harness (the profile has no judge); ' +
        'judge not calibrated: reported, not gated',
    );
    expect(card.metrics.writingQuality.pass).toBeNull();
  });

  it('does not judge a week that produced no digest', async () => {
    const { card, calls } = await run('light', [4], {
      markdownFor: (weekId) => (weekId === WEEK_41 ? undefined : '# H\n'),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.draft.digest.weekId).toBe(WEEK_40);
    expect(card.metrics.writingQuality.value).toBe(4);
  });

  it('does not judge a week that has no winner, and does not name a judge that never ran', async () => {
    const { calls, card } = await run('light', [], { winner: null });

    expect(calls).toEqual([]);
    expect(card.metrics.writingQuality.value).toBeNull();
    expect(card.metrics.writingQuality.note ?? '').not.toContain('scored by');
    expect(card.models.evalJudge).toBeUndefined();
  });

  it('does not hide a bug in the judge: an error that is not a DigestError stops the run', async () => {
    await expect(run('light', [new TypeError('judge broke')])).rejects.toThrow('judge broke');
  });

  it('keeps the scores of the other weeks when the judge fails on one, and says which', async () => {
    const warn = vi.fn();
    const logger: Logger = { ...noopLogger, warn };

    const { card } = await run('light', [new DigestError('no usable score'), 4], {}, logger);

    expect(card.metrics.writingQuality.value).toBe(4);
    expect(card.metrics.writingQuality.note).toContain(`judge failed on ${WEEK_40}`);
    expect(warn).toHaveBeenCalledWith(
      'Eval judge failed on a week',
      expect.objectContaining({ weekId: WEEK_40, error: 'no usable score' }),
    );
  });

  it('is not measured when the judge fails on every week', async () => {
    const { card } = await run('light', [new DigestError('a'), new DigestError('b')]);

    expect(card.metrics.writingQuality.value).toBeNull();
    expect(card.metrics.writingQuality.note).toContain(`judge failed on ${WEEK_40}, ${WEEK_41}`);
  });

  it('writes a scorecard that matches the schema', async () => {
    const { card } = await run('light', [4, 4]);
    expect(ScorecardSchema.safeParse(card).success).toBe(true);
  });
});

describe('without an eval judge', () => {
  it('leaves writing quality unmeasured on a profile with no judge, as before', async () => {
    await writeStandardWeeks(casesDir());
    const app = makeApp({}, PROFILES.light);

    const card = await runEval(
      { profile: 'light', casesDir: casesDir(), minimums: NONE },
      makeDeps(app, []),
    );

    expect(card.metrics.writingQuality).toMatchObject({ value: null, pass: null });
    expect(card.models.evalJudge).toBeUndefined();
  });
});

describe('a profile that has a judge', () => {
  it('uses the scores the select step wrote and does not ask the eval judge', async () => {
    const { card, calls } = await run('quality', [1, 1], { score: 4.5 });

    expect(calls).toEqual([]);
    expect(card.metrics.writingQuality.value).toBe(4.5);
    expect(card.models.evalJudge).toBeUndefined();
  });
});

describe('the judge calibration with an eval judge', () => {
  it('stays unused for a profile with no judge', async () => {
    await writeJson(casesDir(), 'judge/calibration.json', {
      judgeAgreement: 0.95,
      selectionAgreement: 0.9,
    });

    const { card } = await run('light', [4, 4]);

    expect(card.judgeAgreement).toBeNull();
    expect(card.metrics.writingQuality.pass).toBeNull();
  });
});
