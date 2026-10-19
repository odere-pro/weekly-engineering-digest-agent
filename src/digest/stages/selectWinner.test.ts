import { describe, expect, it } from 'vitest';
import { selectWinner } from './selectWinner';
import type { DecisionAnswer } from '../../models/ModelProvider';
import { DigestError } from '../../shared/errors';
import { JUDGE_CRITERIA } from '../../select/judgePrompt';
import { FakeModelProvider } from '../../../test/fakes';
import {
  PROFILE,
  WEEK,
  WRITER_A,
  WRITER_B,
  checkedDraft,
  contextFor,
  scored,
  stateOf,
} from '../__fixtures__/stageKit';

const selected = [1, 2, 3].map((n) => scored(3, { title: `Runner ${n}.0 ships` }));
const first = checkedDraft(selected, WRITER_A);
const second = checkedDraft(selected, WRITER_B);
const outcomes = [WRITER_A, WRITER_B].map((writer) => ({ writer, passed: true, rejectedBy: [] }));

const level = (value: number): DecisionAnswer => ({
  type: 'score',
  level: value,
  score: value / 4,
  probabilities: {},
  confidence: 0.9,
});

/** The judge gives the first draft it sees `levels[0]`, the second `levels[1]`, and so on. */
function judge(...levels: number[]) {
  let calls = 0;
  return new FakeModelProvider({
    decide: () => {
      const value = levels[calls++];
      return Object.fromEntries(
        value === undefined ? [] : JUDGE_CRITERIA.map((criterion) => [criterion, level(value)]),
      );
    },
  });
}

const stateWith = (...passed: (typeof first)[]) =>
  stateOf({ selected, passed, drafts: outcomes.slice(0, passed.length) });

describe('selectWinner', () => {
  it('fails when no draft passed: the stage before should have settled the run', async () => {
    const h = contextFor();

    const failure = await selectWinner(h.ctx, stateOf(), h.logger).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DigestError);
    expect(failure).toMatchObject({
      step: 'select',
      message: 'select ran without a passing draft',
    });
  });

  it('takes the only passing draft without asking the judge, and writes digest.md', async () => {
    const model = judge(4);
    const h = contextFor({ model });

    const next = await selectWinner(h.ctx, stateWith(first), h.logger);

    expect(next.winner).toBe(first);
    expect(model.decideCalls).toEqual([]);
    expect(h.store.artifacts.get(`${WEEK}/digest.md`)).toBe(first.markdown);
    expect(next.drafts).toEqual(outcomes.slice(0, 1));
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'Winner chosen',
        fields: expect.objectContaining({ writer: WRITER_A, judged: false }) as object,
      }),
    );
  });

  it('takes the first passing draft when the profile has no judge', async () => {
    const model = judge(4, 1);
    const h = contextFor({ model, profile: { ...PROFILE, judge: null } });

    const next = await selectWinner(h.ctx, stateWith(first, second), h.logger);

    expect(next.winner).toBe(first);
    expect(model.decideCalls).toEqual([]);
  });

  it('has the judge score each passing draft and picks the higher one, recording the scores', async () => {
    const model = judge(2, 4);
    const h = contextFor({ model });

    const next = await selectWinner(h.ctx, stateWith(first, second), h.logger);

    expect(model.decideCalls.map((call) => call.role)).toEqual(['judge', 'judge']);
    expect(next.winner).toBe(second);
    expect(h.store.artifacts.get(`${WEEK}/digest.md`)).toBe(second.markdown);
    expect(next.drafts.map((outcome) => outcome.score?.writer)).toEqual([WRITER_A, WRITER_B]);
    expect(next.drafts[1]?.score?.score).toBeGreaterThan(next.drafts[0]?.score?.score ?? 5);
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'Winner chosen',
        fields: expect.objectContaining({ writer: WRITER_B, judged: true }) as object,
      }),
    );
  });

  it('falls back to the first draft in writer order, without scores, when the judge gives no usable answer', async () => {
    const h = contextFor({ model: judge() });

    const next = await selectWinner(h.ctx, stateWith(second, first), h.logger);

    expect(next.winner).toBe(first);
    expect(next.drafts.every((outcome) => outcome.score === undefined)).toBe(true);
    expect(h.logs.some((line) => line.level === 'warn')).toBe(true);
  });

  it('holds digest.md when the earlier files of the week must stay', async () => {
    const h = contextFor({ holdArtifacts: true });

    const next = await selectWinner(h.ctx, stateWith(first), h.logger);

    expect(h.store.artifacts.size).toBe(0);
    expect(next.held).toEqual([{ name: 'digest.md', content: first.markdown }]);
  });
});
