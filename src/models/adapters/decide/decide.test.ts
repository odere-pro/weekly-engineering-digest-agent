import { describe, expect, it } from 'vitest';
import { PROFILES } from '../../../config/profiles';
import { DigestError } from '../../../shared/errors';
import { MIN_STATE_CHARS } from '../systemone';
import {
  BASE_URL,
  DECIDE,
  fakeContext,
  fixture,
  hang,
  json,
  sequence,
} from '../__fixtures__/ollamaHarness';
import { decide } from './decide';

describe('decide', () => {
  it('posts the recorded systemone request for the role model', async () => {
    const { context, calls } = fakeContext(
      sequence(() => json(200, fixture('systemone-strands-decider.json'))),
    );

    await decide(context, DECIDE);

    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/systemone`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual(fixture('systemone-request.json'));
  });

  it('maps the recorded clef answers, usage and model', async () => {
    const { context, calls, lines } = fakeContext(
      sequence(() => json(200, fixture('systemone-clef.json'))),
      { profile: PROFILES.quality },
    );

    const result = await decide(context, DECIDE);

    expect(calls[0]!.body).toMatchObject({ model: 'clef:latest' });
    expect(result.model).toBe('clef:latest');
    expect(result.usage).toEqual({ inputTokens: 359, outputTokens: 0 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.answers.hype).toEqual({ type: 'yesno', probability: 0.023689471299374428 });
    expect(result.answers.area).toMatchObject({ type: 'choice', choice: 'inference' });
    expect(result.answers.relevance).toMatchObject({ type: 'score', level: 2.7116717645265753 });
    expect(lines[0]).toMatchObject({
      level: 'info',
      fields: { role: 'classify', model: 'clef:latest', op: 'decide', inputTokens: 359 },
    });
  });

  it('validates the questions before calling Ollama', async () => {
    const { context, calls } = fakeContext(sequence(() => json(200, {})));
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [
        `q${i}`,
        { type: 'yesno', instructions: 'x' } as const,
      ]),
    );
    await expect(decide(context, { ...DECIDE, questions: tooMany })).rejects.toThrow(
      'decide needs 1-64 questions, got 65',
    );
    expect(calls).toHaveLength(0);
  });

  it('fails clearly when the profile has no model for the role', async () => {
    const { context, calls } = fakeContext(sequence(() => json(200, {})));

    await expect(decide(context, { ...DECIDE, role: 'judge' })).rejects.toThrow(
      'No model is configured for role judge in profile light',
    );
    expect(calls).toHaveLength(0);
  });

  it('fails when the answers miss a question, without retrying', async () => {
    const { context, calls } = fakeContext(sequence(() => json(200, { answers: {} })));

    await expect(decide(context, DECIDE)).rejects.toThrow(DigestError);
    expect(calls).toHaveLength(1);
  });

  it('never sends think, and does not log it', async () => {
    const { context, calls, lines } = fakeContext(
      sequence(() => json(200, fixture('systemone-strands-decider.json'))),
      { think: { classify: true, guardRisk: false } },
    );

    await decide(context, DECIDE);

    expect(calls[0]!.body).not.toHaveProperty('think');
    expect(lines[0]!.fields).not.toHaveProperty('think');
  });

  it('passes the caller’s abort through without a second request', async () => {
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    controller.abort(reason);
    const { context, calls } = fakeContext((call) => hang(call.signal));

    await expect(decide(context, { ...DECIDE, signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
  });
});

describe('decide: the state sent', () => {
  /** The one question of these tests, as /v1/systemone gets it. */
  const MINOR = { minor: { type: 'yesno', instructions: 'Is this a minor release?' } } as const;
  const MINOR_CHARS = '{"minor":{"type":"noul","instructions":"Is this a minor release?"}}'.length;
  const reply = (): Response => json(200, fixture('systemone-yesno-no-criteria.json'));

  it('trims the state to the strands-decider budget minus the questions, and logs it', async () => {
    const { context, calls, lines } = fakeContext(sequence(reply));
    const state = `<<<DATA item>>>\n${'a'.repeat(12_000)}\n<<<END DATA>>>`;

    await decide(context, { role: 'classify', state, questions: MINOR });

    const sent = (calls[0]!.body as { state: string }).state;
    expect(sent).toHaveLength(10_000 - MINOR_CHARS);
    expect(sent.endsWith('<<<END DATA>>>')).toBe(true);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({
          fromChars: state.length,
          toChars: 10_000 - MINOR_CHARS,
          questionChars: MINOR_CHARS,
        }) as unknown,
      }),
    );
  });

  it('trims a state that would fit alone when the questions use up the room', async () => {
    const answer = { type: 'choice', choice: 'area0', probabilities: { area0: 1 }, confidence: 1 };
    const { context, calls } = fakeContext(
      sequence(() => json(200, { answers: { area: answer } })),
    );
    const options = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`area${i}`, 'x'.repeat(100)]),
    );
    const questions = { area: { type: 'choice', instructions: 'Which?', options } } as const;
    const state = 'c'.repeat(9_000);

    await decide(context, { role: 'classify', state, questions });

    const sent = (calls[0]!.body as { state: string }).state;
    const sentQuestions = (calls[0]!.body as { questions: unknown }).questions;
    expect(sent.length).toBeLessThan(state.length);
    expect(sent.length + JSON.stringify(sentQuestions).length).toBeLessThanOrEqual(10_000);
  });

  it('sends the whole state when the state and the questions fit together', async () => {
    const { context, calls, lines } = fakeContext(sequence(reply));
    const state = 'd'.repeat(10_000 - MINOR_CHARS);

    await decide(context, { role: 'classify', state, questions: MINOR });

    expect((calls[0]!.body as { state: string }).state).toBe(state);
    expect(lines.filter((line) => line.level === 'warn')).toEqual([]);
  });

  it('keeps a minimum of the state when the questions alone fill the context', async () => {
    const { context, calls } = fakeContext(sequence(reply));
    const questions = {
      minor: { type: 'yesno', instructions: 'y'.repeat(12_000) },
    } as const;

    await decide(context, { role: 'classify', state: 'e'.repeat(5_000), questions });

    expect((calls[0]!.body as { state: string }).state).toHaveLength(MIN_STATE_CHARS);
  });

  it('keeps a long state for clef within its larger budget', async () => {
    const { context, calls } = fakeContext(sequence(reply), { profile: PROFILES.quality });
    const state = 'b'.repeat(12_000);

    await decide(context, {
      role: 'classify',
      state,
      questions: { minor: { type: 'yesno', instructions: 'Is this a minor release?' } },
    });

    expect((calls[0]!.body as { state: string }).state).toBe(state);
  });
});
