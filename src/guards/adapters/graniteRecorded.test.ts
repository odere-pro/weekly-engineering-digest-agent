// Replays replies recorded from a live granite4.1-guardian:8b (src/guards/adapters/__fixtures__/granite/*.json).
// Each fixture also stores the prompts the guard sent. If a prompt changes, these tests fail
// until the fixtures are recorded again, so the replies stay representative of the prompts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createGraniteGroundednessGuard, createGraniteRiskGuard } from './granite';
import { DraftSchema, ItemSchema } from '../../domain/schemas';
import { GuardVerdictSchema } from '../guardVerdict';
import { FakeModelProvider } from '../../../test/fakes/FakeModelProvider';

const CallSchema = z.object({ system: z.string(), prompt: z.string(), text: z.string() });
const RiskFixtureSchema = z.object({
  description: z.string(),
  guard: z.literal('graniteRisk'),
  input: z.object({ item: ItemSchema }),
  calls: z.array(CallSchema).min(1),
  verdict: GuardVerdictSchema,
});
const GroundednessFixtureSchema = z.object({
  description: z.string(),
  guard: z.literal('graniteGroundedness'),
  input: z.object({ draft: DraftSchema, sources: z.array(ItemSchema) }),
  calls: z.array(CallSchema).min(1),
  verdict: GuardVerdictSchema,
});

function fixture<T extends z.ZodType>(name: string, schema: T): z.infer<T> {
  const raw = readFileSync(new URL(`./__fixtures__/granite/${name}.json`, import.meta.url), 'utf8');
  return schema.parse(JSON.parse(raw));
}

/** The call that judges a draft's headline and intro. It came after these fixtures were recorded. */
const HEADLINE_BLOCK = '<<<DATA text:headline>>>';
const HEADLINE_NO = '<score> no </score>';

/**
 * Replies with the recorded texts in order and keeps the calls the guard makes. The headline and
 * intro call has no recording: it answers "no", so the verdict stays the recorded one.
 */
function replayModel(calls: readonly z.infer<typeof CallSchema>[]): FakeModelProvider {
  let next = 0;
  return new FakeModelProvider({
    generate: (request) =>
      request.prompt.includes(HEADLINE_BLOCK)
        ? HEADLINE_NO
        : (calls[next++]?.text ?? 'replay ran out of calls'),
  });
}

/** The recorded kinds of call the guard made, in order; the headline and intro call is left out. */
function sentPrompts(model: FakeModelProvider): { system: string; prompt: string }[] {
  return model.generateCalls
    .filter(({ prompt }) => !prompt.includes(HEADLINE_BLOCK))
    .map(({ system, prompt }) => ({ system, prompt }));
}

describe('graniteRisk replayed from recorded replies', () => {
  it.each(['risk-benign', 'risk-security-release', 'risk-injection', 'risk-harmful'])(
    'reaches the recorded verdict for %s',
    async (name) => {
      const recorded = fixture(name, RiskFixtureSchema);
      const model = replayModel(recorded.calls);

      const verdict = await createGraniteRiskGuard({ model }).checkItem(recorded.input.item);

      expect(verdict).toEqual(recorded.verdict);
      expect(sentPrompts(model)).toEqual(
        recorded.calls.map(({ system, prompt }) => ({ system, prompt })),
      );
    },
  );

  it('passes release notes and a security release, and flags the hidden instruction', () => {
    const verdicts = Object.fromEntries(
      ['risk-benign', 'risk-security-release', 'risk-injection'].map((name) => [
        name,
        fixture(name, RiskFixtureSchema).verdict.flagged,
      ]),
    );
    expect(verdicts).toEqual({
      'risk-benign': false,
      'risk-security-release': false,
      'risk-injection': true,
    });
  });
});

describe('graniteGroundedness replayed from recorded replies', () => {
  it.each([
    'grounded-all',
    'grounded-fabricated',
    'grounded-subtle',
    'grounded-real-w36-run1',
    'grounded-real-w36-run3',
  ])('reaches the recorded verdict for %s', async (name) => {
    const recorded = fixture(name, GroundednessFixtureSchema);
    const model = replayModel(recorded.calls);
    const { draft, sources } = recorded.input;

    const verdict = await createGraniteGroundednessGuard({ model }).checkDraft(draft, sources);

    expect(verdict).toEqual(recorded.verdict);
    expect(sentPrompts(model)).toEqual(
      recorded.calls.map(({ system, prompt }) => ({ system, prompt })),
    );
  });

  it('passes the two real W36 drafts that the generic criterion blocked', () => {
    for (const name of ['grounded-real-w36-run1', 'grounded-real-w36-run3']) {
      expect(fixture(name, GroundednessFixtureSchema).verdict.flagged).toBe(false);
    }
  });

  it('catches a wrong Python version and names only the vLLM item', () => {
    const { verdict } = fixture('grounded-subtle', GroundednessFixtureSchema);

    expect(verdict.flagged).toBe(true);
    expect(verdict.reason).toContain('vllm-0-12');
    expect(verdict.reason).not.toContain('kserve-0-15');
  });

  it('names the fabricated KServe item and not the grounded vLLM item', () => {
    const { verdict } = fixture('grounded-fabricated', GroundednessFixtureSchema);

    expect(verdict.flagged).toBe(true);
    expect(verdict.reason).toContain('kserve-0-15');
    expect(verdict.reason).not.toContain('vllm-0-12');
  });
});
