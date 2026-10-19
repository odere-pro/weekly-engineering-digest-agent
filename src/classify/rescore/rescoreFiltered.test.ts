import { describe, expect, it, vi } from 'vitest';
import { rescoreFiltered } from './rescoreFiltered';
import {
  FOCUS_AREAS,
  idsInPrompt,
  makeDeps,
  rescoreReply,
  type RescoredAnswer,
} from '../__fixtures__/classifyKit';
import type { ScoredItem } from '../classification';
import { makeScoredItem } from '../../../test/builders';
import { FakeModelProvider, noopLogger } from '../../../test/fakes';

const MIN_RELEVANCE = 1.5;

function scoredItems(count: number, relevance = 2): ScoredItem[] {
  return Array.from({ length: count }, () =>
    makeScoredItem(
      {},
      { relevance, area: FOCUS_AREAS[0], areaConfidence: 0.9, hype: 0.1, minorRelease: 0.2 },
    ),
  );
}

function answer(itemId: string, overrides: Partial<RescoredAnswer> = {}): RescoredAnswer {
  return { itemId, relevance: 3, area: FOCUS_AREAS[0], confidence: 'low', ...overrides };
}

/** A writer that gives every item in the prompt the same answer. */
function writerGiving(overrides: Partial<RescoredAnswer> = {}): FakeModelProvider {
  return new FakeModelProvider({
    generate: (request) =>
      rescoreReply(idsInPrompt(request.prompt).map((itemId) => answer(itemId, overrides))),
  });
}

function run(items: readonly ScoredItem[], model: FakeModelProvider, logger = noopLogger) {
  return rescoreFiltered(items, MIN_RELEVANCE, makeDeps(model, { logger }));
}

describe('rescoreFiltered', () => {
  it('sends only the items at or above minRelevance, in batches of 10, with the write role', async () => {
    const kept = scoredItems(12);
    const edge = makeScoredItem({}, { relevance: MIN_RELEVANCE });
    const dropped = scoredItems(2, 0);
    const model = writerGiving();

    const scored = await run([...dropped, ...kept, edge], model);

    expect(model.generateCalls.map((call) => call.role)).toEqual(['write', 'write']);
    expect(model.generateCalls.map((call) => idsInPrompt(call.prompt))).toEqual([
      kept.slice(0, 10).map((item) => item.id),
      [...kept.slice(10), edge].map((item) => item.id),
    ]);
    expect(scored.map((item) => item.classification.relevance)).toEqual([
      0,
      0,
      ...kept.map(() => 3),
      3,
    ]);
  });

  it('returns every item in input order and does not change the input', async () => {
    const items = Object.freeze(scoredItems(3).map((item) => Object.freeze(item)));
    const model = writerGiving({ relevance: 1 });

    const scored = await run(items, model);

    expect(scored.map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(items.map((item) => item.classification.relevance)).toEqual([2, 2, 2]);
  });

  it('replaces relevance always and the area only when the writer is highly confident', async () => {
    const [high, low] = scoredItems(2) as [ScoredItem, ScoredItem];
    const model = new FakeModelProvider({
      generate: () =>
        rescoreReply([
          answer(high.id, { relevance: 3, area: FOCUS_AREAS[1], confidence: 'high' }),
          answer(low.id, { relevance: 2, area: FOCUS_AREAS[1], confidence: 'low' }),
        ]),
    });

    const scored = await run([high, low], model);

    expect(scored[0]?.classification).toMatchObject({
      relevance: 3,
      area: FOCUS_AREAS[1],
      areaConfidence: 1,
    });
    expect(scored[1]?.classification).toMatchObject({
      relevance: 2,
      area: FOCUS_AREAS[0],
      areaConfidence: 0.9,
    });
  });

  it('keeps the decider hype and minorRelease', async () => {
    const [item] = scoredItems(1) as [ScoredItem];
    const model = writerGiving({ relevance: 0, area: 'other', confidence: 'high' });

    const [scored] = await run([item], model);

    expect(scored?.classification).toMatchObject({ hype: 0.1, minorRelease: 0.2 });
  });

  it('keeps the decider scores and warns when a batch fails', async () => {
    const warn = vi.fn();
    const items = scoredItems(11);
    const model = new FakeModelProvider({ generate: () => 'not json' });

    const scored = await run(items, model, { ...noopLogger, warn });

    expect(scored).toEqual(items);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('keeps the decider scores of a failed batch and rescores the other', async () => {
    const items = scoredItems(11);
    let call = 0;
    const model = new FakeModelProvider({
      generate: (request) => {
        call += 1;
        if (call === 1) throw new Error('boom');
        return rescoreReply(
          idsInPrompt(request.prompt).map((itemId) => answer(itemId, { relevance: 0 })),
        );
      },
    });

    const scored = await run(items, model);

    expect(scored.map((item) => item.classification.relevance)).toEqual([
      ...items.slice(0, 10).map(() => 2),
      0,
    ]);
  });

  it('makes no writer call when no item passed the filter', async () => {
    const model = writerGiving();

    const scored = await run(scoredItems(2, 0), model);

    expect(model.generateCalls).toHaveLength(0);
    expect(scored.map((item) => item.classification.relevance)).toEqual([0, 0]);
  });

  it('makes no writer call for no items', async () => {
    const model = writerGiving();

    expect(await run([], model)).toEqual([]);
    expect(model.generateCalls).toHaveLength(0);
  });

  it('logs how many items it sent and how many the writer rescored', async () => {
    const info = vi.fn();
    const items = [...scoredItems(3), ...scoredItems(1, 0)];
    const model = new FakeModelProvider({
      generate: () => rescoreReply([answer(items[0]?.id ?? '')]),
    });

    await run(items, model, { ...noopLogger, info });

    expect(info).toHaveBeenCalledWith('Rescored items with the writer model', {
      sent: 3,
      rescored: 1,
    });
  });
});
