// The item criterion (W11-03). Under the generic definition Granite flagged a "why it matters"
// line that only draws a conclusion from the source, which blocked real, grounded weeks.
import { describe, expect, it } from 'vitest';
import { GRANITE_CRITERIA, createGraniteGroundednessGuard } from './granite';
import { DATA_OPEN, UNTRUSTED_DATA_RULE } from '../../shared/untrusted';
import { makeDraft, makeItem } from '../../../test/builders';
import { FakeModelProvider } from '../../../test/fakes/FakeModelProvider';

const isHeadlineCall = (prompt: string): boolean =>
  prompt.includes(`${DATA_OPEN} text:headline>>>`);

describe('the item criterion', () => {
  const source = makeItem({ title: 'Ollama pricing', summary: 'Plans use per-token pricing.' });
  const draft = makeDraft([source], 'w', { headline: 'Platform week 37', intro: 'One release.' });

  it('is the system prompt of every item call, followed by the data rule', async () => {
    const model = new FakeModelProvider({ generate: () => '<score>no</score>' });

    await createGraniteGroundednessGuard({ model }).checkDraft(draft, [source]);

    const itemCalls = model.generateCalls.filter((call) => !isHeadlineCall(call.prompt));
    expect(itemCalls).toHaveLength(1);
    expect(itemCalls[0]?.system).toBe(`${GRANITE_CRITERIA.item}\n\n${UNTRUSTED_DATA_RULE}`);
  });

  it('names the facts a reader could be misled by, even a one-digit difference', () => {
    for (const fact of ['version number', 'date', 'number or benchmark', 'capability', 'default']) {
      expect(GRANITE_CRITERIA.item).toContain(fact);
    }
    expect(GRANITE_CRITERIA.item).toMatch(/one digit or one day/i);
  });

  it('says that explaining why a release matters is a judgement, not a fact', () => {
    expect(GRANITE_CRITERIA.item).toMatch(/why a release matters/i);
    expect(GRANITE_CRITERIA.item).toMatch(/judgement and not a fact/i);
    expect(GRANITE_CRITERIA.item).toMatch(/unless it adds such a fact/i);
  });

  it('still blocks the draft when the item call answers yes', async () => {
    const model = new FakeModelProvider({
      generate: (request) =>
        isHeadlineCall(request.prompt) ? '<score>no</score>' : '<score>yes</score>',
    });

    const verdict = await createGraniteGroundednessGuard({ model }).checkDraft(draft, [source]);

    expect(verdict).toEqual({
      check: 'graniteGroundedness',
      flagged: true,
      reason: `ungrounded items: ${source.id}`,
    });
  });
});
