import { describe, expect, it } from 'vitest';
import type { DecisionQuestion } from '../../ModelProvider';
import { recordingLogger, type Line } from '../__fixtures__/ollamaHarness';
import { MIN_STATE_CHARS, toSystemOneQuestions } from '../systemone';
import { fitState } from './fitState';

const STRANDS = 'strands-decider:2b-mlx-bf16';
const CLEF = 'clef:latest';
const MINOR: Record<string, DecisionQuestion> = {
  minor: { type: 'yesno', instructions: 'Is this a minor release?' },
};
const MINOR_CHARS = '{"minor":{"type":"noul","instructions":"Is this a minor release?"}}'.length;

function run(model: string, state: string, questions: Record<string, DecisionQuestion> = MINOR) {
  const lines: Line[] = [];
  const fitted = fitState(
    recordingLogger(lines),
    { role: 'classify', model },
    state,
    toSystemOneQuestions(questions),
  );
  return { fitted, lines };
}

describe('fitState', () => {
  it('returns the state as it is, and logs nothing, when it fits with the questions', () => {
    const state = 'a'.repeat(10_000 - MINOR_CHARS);

    const { fitted, lines } = run(STRANDS, state);

    expect(fitted).toBe(state);
    expect(lines).toEqual([]);
  });

  it('cuts a state to the small-context budget less the questions, keeping the end', () => {
    const state = `${'a'.repeat(12_000)}<<<END DATA>>>`;

    const { fitted } = run(STRANDS, state);

    expect(fitted).toHaveLength(10_000 - MINOR_CHARS);
    expect(fitted.endsWith('<<<END DATA>>>')).toBe(true);
    expect(fitted).toContain('[... trimmed ...]');
  });

  it('logs what was cut with the role and model of the call', () => {
    const state = 'a'.repeat(12_000);

    const { lines } = run(STRANDS, state);

    expect(lines).toEqual([
      {
        level: 'warn',
        message: 'decide state trimmed',
        fields: {
          role: 'classify',
          model: STRANDS,
          fromChars: 12_000,
          toChars: 10_000 - MINOR_CHARS,
          questionChars: MINOR_CHARS,
        },
      },
    ]);
  });

  it('gives a model with a larger context a larger budget', () => {
    const state = 'b'.repeat(12_000);

    expect(run(CLEF, state).fitted).toBe(state);
  });

  it('keeps a minimum of the state when the questions alone fill the context', () => {
    const questions: Record<string, DecisionQuestion> = {
      minor: { type: 'yesno', instructions: 'y'.repeat(12_000) },
    };

    const { fitted } = run(STRANDS, 'e'.repeat(5_000), questions);

    expect(fitted).toHaveLength(MIN_STATE_CHARS);
  });
});
