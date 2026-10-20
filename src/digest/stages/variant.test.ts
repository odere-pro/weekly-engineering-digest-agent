import { describe, expect, it } from 'vitest';
import { classify } from './classify';
import { processItems } from './processItems';
import { write } from './write';
import { QUESTION_IDS } from '../../classify/classifyPrompt';
import { FakeModelProvider } from '../../../test/fakes';
import { makeItem } from '../../../test/builders';
import { AREA, contextFor, scored, stateOf } from '../__fixtures__/stageKit';
import type { RunVariant } from '../variant';

const TOPIC = 'zero-trust networking';

function recordingModel() {
  return new FakeModelProvider({
    decide: () => ({
      [QUESTION_IDS.relevance]: {
        type: 'score',
        level: 2,
        score: 0.6,
        probabilities: {},
        confidence: 0.9,
      },
      [QUESTION_IDS.area]: { type: 'choice', choice: AREA, probabilities: {}, confidence: 0.9 },
      [QUESTION_IDS.hype]: { type: 'yesno', probability: 0.1 },
      [QUESTION_IDS.minorRelease]: { type: 'yesno', probability: 0.1 },
    }),
    generate: () => '{}',
  });
}

const asked = (model: FakeModelProvider): string =>
  JSON.stringify([...model.decideCalls, ...model.generateCalls]);

describe('classify and write with a variant', () => {
  const kept = [makeItem(), makeItem()];

  it.each<[string, RunVariant | undefined, boolean]>([
    ['perspective', { kind: 'perspective', topic: TOPIC }, true],
    ['complete', { kind: 'complete', topic: TOPIC }, false],
    ['no variant', undefined, false],
  ])('classify: %s', async (_name, variant, expected) => {
    const model = recordingModel();
    const h = contextFor({ model, variant });

    await classify(h.ctx, stateOf({ kept }), h.logger);

    expect(asked(model).includes(TOPIC)).toBe(expected);
  });

  it.each<[string, RunVariant, boolean]>([
    ['perspective', { kind: 'perspective', topic: TOPIC }, true],
    ['enrich', { kind: 'enrich' }, false],
  ])('write: %s', async (_name, variant, expected) => {
    const model = recordingModel();
    const h = contextFor({ model, variant });
    const selected = [scored(3), scored(2.9), scored(2.8)];

    await write(h.ctx, stateOf({ selected, collected: selected }), h.logger).catch(() => undefined);

    expect(JSON.stringify(model.generateCalls).includes(TOPIC)).toBe(expected);
  });
});

describe('processItems with a variant', () => {
  const tied = [scored(2.5), scored(2.5), scored(2.5), scored(2.5)];

  it('lets a kept URL win a relevance tie and stores every eligible item', async () => {
    const last = tied[3]!;
    const h = contextFor({
      config: { topN: 3 },
      variant: { kind: 'enrich', keepUrls: [`${last.url}?utm_source=x`] },
    });

    const next = await processItems(h.ctx, stateOf({ scored: tied }), h.logger);

    expect(next.selected.map((item) => item.id)).toContain(last.id);
    expect(next.eligible).toHaveLength(4);
  });

  it('ranks the same tie differently without keepUrls', async () => {
    const h = contextFor({ config: { topN: 3 } });

    const next = await processItems(h.ctx, stateOf({ scored: tied }), h.logger);

    expect(next.selected.map((item) => item.id)).not.toContain(tied[3]!.id);
  });
});
