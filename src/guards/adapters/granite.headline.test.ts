// The headline-and-intro call has a criterion of its own (W5-11). Judged by the generic
// groundedness definition, Granite flagged 5 of the 10 clean grounding controls on the light
// profile, every time on this call and never on an item call.
import { describe, expect, it } from 'vitest';
import { GRANITE_CRITERIA, createGraniteGroundednessGuard } from './granite';
import type { GenerateRequest } from '../../models/ModelProvider';
import { DATA_OPEN, UNTRUSTED_DATA_RULE } from '../../shared/untrusted';
import { makeDraft, makeItem } from '../../../test/builders';
import { FakeModelProvider } from '../../../test/fakes/FakeModelProvider';

const YES = '<score>yes</score>';
const NO = '<score>no</score>';

const isHeadlineCall = (request: Pick<GenerateRequest, 'prompt'>): boolean =>
  request.prompt.includes(`${DATA_OPEN} text:headline>>>`);

describe('the headline and intro criterion', () => {
  const first = makeItem({ title: 'vLLM 0.12', summary: 'Adds speculative decoding.' });
  const second = makeItem({ title: 'KServe 0.15', summary: 'Adds a new inference graph.' });
  const draft = makeDraft([first, second], 'w', {
    headline: 'Platform and AI tooling, week 37',
    intro: 'Three releases worth a look this week.',
  });
  const sources = [first, second];

  async function callsFor() {
    const model = new FakeModelProvider({ generate: () => NO });
    await createGraniteGroundednessGuard({ model }).checkDraft(draft, sources);
    return {
      headline: model.generateCalls.filter(isHeadlineCall),
      items: model.generateCalls.filter((call) => !isHeadlineCall(call)),
    };
  }

  it('is used for the headline and intro call, with the data rule after it', async () => {
    const { headline } = await callsFor();

    expect(headline).toHaveLength(1);
    expect(headline[0]?.system).toBe(`${GRANITE_CRITERIA.headline}\n\n${UNTRUSTED_DATA_RULE}`);
  });

  it('leaves every item call on the model-defined groundedness criterion', async () => {
    const { items } = await callsFor();

    expect(items).toHaveLength(2);
    for (const call of items) {
      expect(call.system).toBe(`${GRANITE_CRITERIA.groundedness}\n\n${UNTRUSTED_DATA_RULE}`);
    }
  });

  it('flags facts about a release that no document supports, and not the framing around them', () => {
    const criterion = GRANITE_CRITERIA.headline;

    expect(criterion).toMatch(/ungrounded/i);
    for (const fact of ['version number', 'date', 'benchmark', 'capability', 'security fix']) {
      expect(criterion).toContain(fact);
    }
    expect(criterion).toMatch(/naming the week/i);
    expect(criterion).toMatch(/counting the releases/i);
    expect(criterion).toMatch(/does not make a text ungrounded/i);
  });

  it('is not the generic criterion, which the items still use', () => {
    expect(GRANITE_CRITERIA.headline).not.toBe(GRANITE_CRITERIA.groundedness);
  });

  it('still blocks the draft when that call says the headline or intro is ungrounded', async () => {
    const model = new FakeModelProvider({
      generate: (request) => (isHeadlineCall(request) ? YES : NO),
    });

    const verdict = await createGraniteGroundednessGuard({ model }).checkDraft(draft, sources);

    expect(verdict).toEqual({
      check: 'graniteGroundedness',
      flagged: true,
      reason: 'ungrounded headline or intro',
    });
  });

  it('does not let a per-item answer decide the headline, or the other way round', async () => {
    const model = new FakeModelProvider({
      generate: (request) => (isHeadlineCall(request) ? NO : YES),
    });

    const verdict = await createGraniteGroundednessGuard({ model }).checkDraft(draft, sources);

    expect(verdict.reason).toBe(`ungrounded items: ${first.id}, ${second.id}`);
  });
});
