// The run's abort signal reaches every writer call. Writers run in turn: once it fires no further
// writer starts, and an aborted writer is never recorded as a failure of that writer (the step
// rejects instead, so no `drafts.json` entry blames the model for a run that was told to stop).
import { describe, expect, it } from 'vitest';
import { retryStep, writeCheckedStep, writeStep, type WriteDeps } from './write';
import type { ScoredItem } from '../classify/classification';
import type { DigestItem } from '../domain/schemas';
import type { GenerateRequest } from '../models/ModelProvider';
import { makeDigestItem, makeScoredItem } from '../../test/builders';
import { FakeModelProvider, noopLogger } from '../../test/fakes';

const REASON = new Error('run timed out after 2 h');

const items: ScoredItem[] = Array.from({ length: 4 }, (_, i) =>
  makeScoredItem({ title: `Tool ${i + 1} ships`, summary: `Tool ${i + 1} adds a feature.` }),
);

function body(given: readonly DigestItem[]): string {
  return JSON.stringify({
    headline: 'Three releases worth your time',
    intro: 'Platform and model tooling moved this week.',
    items: given,
  });
}

const validReply = (): string =>
  body(
    items.map((item) =>
      makeDigestItem(item, { urgency: 'worth-a-look', action: 'Relevant if you run it.' }),
    ),
  );

function makeDeps(model: FakeModelProvider, signal?: AbortSignal): WriteDeps {
  return {
    model,
    writers: ['writer-a', 'writer-b'],
    focusAreas: ['AI models and tooling', 'Platform engineering'],
    weekId: '2026-W42',
    logger: noopLogger,
    signal,
  };
}

/** Ends only when `signal` fires, with its reason, as a forwarded Ollama call does. */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => {
      reject(signal?.reason as Error);
    };
    if (signal?.aborted) fail();
    else signal?.addEventListener('abort', fail, { once: true });
  });
}

const writersCalled = (model: FakeModelProvider): (string | undefined)[] =>
  model.generateCalls.map((call) => call.model);

describe('writeStep with an abort signal', () => {
  it('hands the signal to the call of every writer', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({ generate: validReply });

    await writeStep(items, makeDeps(model, controller.signal));

    expect(writersCalled(model)).toEqual(['writer-a', 'writer-b']);
    expect(model.generateCalls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  it('throws the reason and starts no writer when the signal fired before the start', async () => {
    const controller = new AbortController();
    controller.abort(REASON);
    const model = new FakeModelProvider({ generate: validReply });

    const result = writeStep(items, makeDeps(model, controller.signal));

    await expect(result).rejects.toBe(REASON);
    expect(model.generateCalls).toEqual([]);
  });

  it('starts no further writer once the signal fires, and keeps no draft', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({
      generate: () => {
        controller.abort(REASON);
        return validReply();
      },
    });

    const result = writeStep(items, makeDeps(model, controller.signal));

    await expect(result).rejects.toBe(REASON);
    expect(writersCalled(model)).toEqual(['writer-a']);
  });

  it('rejects, rather than listing the writer as failed, when its call is aborted', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({
      generate: (request) => hangUntilAborted(request.signal),
    });
    const result = writeStep(items, makeDeps(model, controller.signal));
    await Promise.resolve();
    expect(writersCalled(model)).toEqual(['writer-a']);

    controller.abort(REASON);

    await expect(result).rejects.toBe(REASON);
    expect(writersCalled(model)).toEqual(['writer-a']);
  });

  it('still lists a writer that failed for its own reason while the signal has not fired', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({
      generate: (request: GenerateRequest) => {
        if (request.model === 'writer-a') throw new Error('model crashed');
        return validReply();
      },
    });

    const out = await writeStep(items, makeDeps(model, controller.signal));

    expect(out.failures).toEqual([{ writer: 'writer-a', error: 'model crashed' }]);
    expect(out.drafts.map((draft) => draft.writer)).toEqual(['writer-b']);
  });

  it('works as before without a signal', async () => {
    const model = new FakeModelProvider({ generate: validReply });

    const out = await writeStep(items, makeDeps(model));

    expect(out.drafts).toHaveLength(2);
  });
});

describe('retryStep with an abort signal', () => {
  const requests = [
    { writer: 'writer-b', problems: ['Unknown URL'] },
    { writer: 'writer-a', problems: ['Unknown URL'] },
  ];

  it('hands the signal to the retry call', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({ generate: validReply });

    await retryStep(items, requests, makeDeps(model, controller.signal));

    expect(model.generateCalls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  it('starts no retry when the signal fired before the start', async () => {
    const controller = new AbortController();
    controller.abort(REASON);
    const model = new FakeModelProvider({ generate: validReply });

    const result = retryStep(items, requests, makeDeps(model, controller.signal));

    await expect(result).rejects.toBe(REASON);
    expect(model.generateCalls).toEqual([]);
  });

  it('starts no further retry once the signal fires, and records no failure', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({
      generate: () => {
        controller.abort(REASON);
        return validReply();
      },
    });

    const result = retryStep(items, requests, makeDeps(model, controller.signal));

    await expect(result).rejects.toBe(REASON);
    expect(writersCalled(model)).toEqual(['writer-b']);
  });
});

describe('writeCheckedStep with an abort signal', () => {
  const checked = (model: FakeModelProvider, signal: AbortSignal) => ({
    ...makeDeps(model, signal),
    collected: items,
    disabledGuards: [],
    topN: 5,
  });

  /** Valid for the writer schema, far over the word limit: the format check rejects it. */
  const tooManyWords = (): string =>
    JSON.stringify({ ...(JSON.parse(validReply()) as object), headline: 'word '.repeat(600) });

  it('retries the writers when the checks rejected every draft and the signal has not fired', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({ generate: tooManyWords });

    const out = await writeCheckedStep(items, checked(model, controller.signal));

    expect(writersCalled(model)).toEqual(['writer-a', 'writer-b', 'writer-b', 'writer-a']);
    expect(out.rejections).toHaveLength(4);
  });

  it('starts no retry when the signal fires during the last writer', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({
      generate: (request) => {
        if (request.model === 'writer-b') controller.abort(REASON);
        return tooManyWords();
      },
    });

    const result = writeCheckedStep(items, checked(model, controller.signal));

    await expect(result).rejects.toBe(REASON);
    expect(writersCalled(model)).toEqual(['writer-a', 'writer-b']);
  });
});
