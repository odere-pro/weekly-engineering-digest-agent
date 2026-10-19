import { describe, expect, it, vi } from 'vitest';
import { classifyInBatches } from './classifyInBatches';
import {
  FOCUS_AREAS,
  answerBatch,
  batchReply,
  generated,
  idsInPrompt,
  makeDeps,
  makeItems,
} from '../__fixtures__/classifyKit';
import { makeItem } from '../../../test/builders';
import { FakeModelProvider, noopLogger } from '../../../test/fakes';
import { DigestError } from '../../shared/errors';
import { UNTRUSTED_DATA_RULE } from '../../shared/untrusted';

describe('classifyInBatches', () => {
  it('scores 25 items in 3 batches of at most 10, with no decide call', async () => {
    const model = new FakeModelProvider({ generate: (request) => answerBatch(request) });
    const items = makeItems(25);

    const scored = await classifyInBatches(items, makeDeps(model));

    expect(model.decideCalls).toHaveLength(0);
    expect(model.generateCalls).toHaveLength(3);
    expect(model.generateCalls.map((call) => idsInPrompt(call.prompt))).toEqual([
      items.slice(0, 10).map((item) => item.id),
      items.slice(10, 20).map((item) => item.id),
      items.slice(20).map((item) => item.id),
    ]);
    expect(scored).toHaveLength(25);
  });

  it('calls the model one batch at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const model = new FakeModelProvider({
      generate: async (request) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return answerBatch(request);
      },
    });

    await classifyInBatches(makeItems(25), makeDeps(model));

    expect(maxInFlight).toBe(1);
  });

  it('asks for structured output with the untrusted-data rule and the focus areas', async () => {
    const model = new FakeModelProvider({ generate: (request) => answerBatch(request) });

    await classifyInBatches(makeItems(2), makeDeps(model));

    const request = model.generateCalls[0];
    expect(request?.role).toBe('classify');
    expect(request?.jsonSchema).toBeDefined();
    expect(request?.system).toContain(UNTRUSTED_DATA_RULE);
    for (const area of FOCUS_AREAS) expect(request?.system).toContain(area);
  });

  it('puts the source tags in the batch prompt', async () => {
    const model = new FakeModelProvider({ generate: (request) => answerBatch(request) });
    const item = makeItem({ sourceId: 'vllm' });

    await classifyInBatches(
      [item],
      makeDeps(model, { areaHints: new Map([['vllm', 'platform']]) }),
    );

    expect(model.generateCalls[0]?.prompt).toContain(`Source tag for ${item.id}: platform`);
  });

  it('maps the generated scores and tags to a classification', async () => {
    const items = makeItems(1);
    const id = items[0]?.id ?? '';
    const model = new FakeModelProvider({
      generate: () =>
        batchReply([
          generated(id, { relevance: 3, area: 'other', hype: true, minorRelease: true }),
        ]),
    });

    const [scored] = await classifyInBatches(items, makeDeps(model));

    expect(scored?.classification).toEqual({
      itemId: id,
      relevance: 3,
      area: 'other',
      areaConfidence: 1,
      hype: 1,
      minorRelease: 1,
    });
  });

  it('keeps the item fields and does not change the input', async () => {
    const model = new FakeModelProvider({ generate: (request) => answerBatch(request) });
    const items = Object.freeze(makeItems(2).map((item) => Object.freeze(item)));

    const scored = await classifyInBatches(items, makeDeps(model));

    expect(scored.map(({ classification: _classification, ...item }) => item)).toEqual(items);
    expect(items[0]).not.toHaveProperty('classification');
  });

  it('retries a missing item once in its own batch', async () => {
    const items = makeItems(3);
    const missing = items[1]?.id ?? '';
    let calls = 0;
    const model = new FakeModelProvider({
      generate: (request) =>
        ++calls === 1
          ? answerBatch(request, new Set([missing]))
          : batchReply([generated(missing, { relevance: 1 })]),
    });

    const scored = await classifyInBatches(items, makeDeps(model));

    expect(model.generateCalls).toHaveLength(2);
    expect(idsInPrompt(model.generateCalls[1]?.prompt ?? '')).toEqual([missing]);
    expect(scored[1]?.classification.relevance).toBe(1);
  });

  it('defaults an item missing after its retry to not relevant and logs a warning', async () => {
    const warn = vi.fn();
    const items = makeItems(12);
    const missing = new Set([items[3]?.id ?? '', items[11]?.id ?? '']);
    const model = new FakeModelProvider({
      generate: (request) => answerBatch(request, missing),
    });

    const scored = await classifyInBatches(
      items,
      makeDeps(model, { logger: { ...noopLogger, warn } }),
    );

    expect(model.generateCalls).toHaveLength(3);
    expect(idsInPrompt(model.generateCalls[2]?.prompt ?? '')).toEqual([...missing]);
    for (const index of [3, 11]) {
      expect(scored[index]?.classification).toEqual({
        itemId: items[index]?.id,
        relevance: 0,
        area: 'other',
        areaConfidence: 0,
        hype: 0,
        minorRelease: 0,
      });
    }
    expect(scored[0]?.classification.relevance).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/missing/i),
      expect.objectContaining({ itemIds: [...missing] }),
    );
  });

  it('does not warn and does not retry when every item is answered', async () => {
    const warn = vi.fn();
    const model = new FakeModelProvider({ generate: (request) => answerBatch(request) });

    await classifyInBatches(makeItems(4), makeDeps(model, { logger: { ...noopLogger, warn } }));

    expect(model.generateCalls).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the items in input order when the model shuffles its answers', async () => {
    const items = makeItems(5);
    const model = new FakeModelProvider({
      generate: (request) =>
        batchReply(
          idsInPrompt(request.prompt)
            .toReversed()
            .map((id, index) => generated(id, { relevance: index % 4 })),
        ),
    });

    const scored = await classifyInBatches(items, makeDeps(model));

    expect(scored.map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(scored.map((item) => item.classification.itemId)).toEqual(items.map((item) => item.id));
    expect(scored.map((item) => item.classification.relevance)).toEqual([0, 3, 2, 1, 0]);
  });

  it('keeps the first answer when the model repeats an item', async () => {
    const items = makeItems(1);
    const id = items[0]?.id ?? '';
    const model = new FakeModelProvider({
      generate: () =>
        batchReply([generated(id, { relevance: 3 }), generated(id, { relevance: 0 })]),
    });

    const [scored] = await classifyInBatches(items, makeDeps(model));

    expect(scored?.classification.relevance).toBe(3);
  });

  it('fails the step when the output stays invalid after one repair', async () => {
    const model = new FakeModelProvider({ generate: () => '{"items": "not a list"}' });

    const result = classifyInBatches(makeItems(2), makeDeps(model));

    await expect(result).rejects.toMatchObject({ step: 'classify' });
    expect(model.generateCalls).toHaveLength(2);
  });

  it('rejects an area that is neither a focus area nor "other"', async () => {
    const items = makeItems(1);
    const id = items[0]?.id ?? '';
    const model = new FakeModelProvider({
      generate: () => batchReply([generated(id, { area: 'Cooking' })]),
    });

    await expect(classifyInBatches(items, makeDeps(model))).rejects.toBeInstanceOf(DigestError);
    expect(model.generateCalls).toHaveLength(2);
  });

  it('rejects an item id that is not in the batch', async () => {
    const model = new FakeModelProvider({
      generate: () => batchReply([generated('not-in-batch')]),
    });

    await expect(classifyInBatches(makeItems(1), makeDeps(model))).rejects.toBeInstanceOf(
      DigestError,
    );
    expect(model.generateCalls).toHaveLength(2);
  });

  it.each([4, -1, 2.5])(
    'rejects a relevance of %s: it is never clamped into 0..3',
    async (value) => {
      const items = makeItems(1);
      const id = items[0]?.id ?? '';
      const model = new FakeModelProvider({
        generate: () => batchReply([generated(id, { relevance: value })]),
      });

      await expect(classifyInBatches(items, makeDeps(model))).rejects.toBeInstanceOf(DigestError);
    },
  );

  it('uses a batch repaired after invalid output and logs the repair', async () => {
    const warn = vi.fn();
    const items = makeItems(2);
    let calls = 0;
    const model = new FakeModelProvider({
      generate: () =>
        ++calls === 1
          ? 'not json'
          : batchReply(items.map((item) => generated(item.id, { relevance: 3 }))),
    });

    const scored = await classifyInBatches(
      items,
      makeDeps(model, { logger: { ...noopLogger, warn } }),
    );

    expect(model.generateCalls).toHaveLength(2);
    expect(scored.map((item) => item.classification.relevance)).toEqual([3, 3]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/repaired/i),
      expect.objectContaining({ itemIds: items.map((item) => item.id) }),
    );
  });

  it('fails the step when the retry batch fails', async () => {
    const items = makeItems(3);
    let calls = 0;
    const model = new FakeModelProvider({
      generate: (request) => {
        calls += 1;
        if (calls === 1) return answerBatch(request, new Set([items[0]?.id ?? '']));
        throw new DigestError('Ollama timed out');
      },
    });

    await expect(classifyInBatches(items, makeDeps(model))).rejects.toThrow('Ollama timed out');
    expect(model.generateCalls).toHaveLength(2);
  });

  it('retries more than 10 missing items in batches of at most 10', async () => {
    const items = makeItems(25);
    let calls = 0;
    const model = new FakeModelProvider({
      generate: (request) => (++calls <= 3 ? batchReply([]) : answerBatch(request)),
    });

    const scored = await classifyInBatches(items, makeDeps(model));

    expect(model.generateCalls.map((call) => idsInPrompt(call.prompt).length)).toEqual([
      10, 10, 5, 10, 10, 5,
    ]);
    expect(scored.every((item) => item.classification.relevance === 2)).toBe(true);
  });
});
