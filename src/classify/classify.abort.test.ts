// The run's abort signal reaches every model call of the classify step: a call that starts gets
// it, no call starts once it fired, and an aborted call is never a score (not even the writer
// rescore, which otherwise keeps the decider's scores when a batch fails).
import { describe, expect, it } from 'vitest';
import { classifyStep } from './classify';
import {
  answerBatch,
  answersFor,
  idsInPrompt,
  makeDeps,
  makeItems,
  rescoreReply,
} from './__fixtures__/classifyKit';
import { FakeModelProvider } from '../../test/fakes';

const REASON = new Error('run timed out after 2 h');

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

describe('classifyStep in decide mode with an abort signal', () => {
  it('hands the signal to every decide call', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({ decide: () => answersFor() });

    await classifyStep(makeItems(3), makeDeps(model, { signal: controller.signal }));

    expect(model.decideCalls).toHaveLength(3);
    expect(model.decideCalls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  it('throws the reason and calls no model when the signal fired before the start', async () => {
    const controller = new AbortController();
    controller.abort(REASON);
    const model = new FakeModelProvider({ decide: () => answersFor() });

    const result = classifyStep(makeItems(3), makeDeps(model, { signal: controller.signal }));

    await expect(result).rejects.toBe(REASON);
    expect(model.decideCalls).toEqual([]);
  });

  it('starts no further call once the signal fires, and returns no scores', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({
      decide: () => {
        controller.abort(REASON);
        return answersFor();
      },
    });

    const result = classifyStep(makeItems(3), makeDeps(model, { signal: controller.signal }));

    await expect(result).rejects.toBe(REASON);
    expect(model.decideCalls).toHaveLength(1);
  });

  it('fails with the call in flight when it is aborted', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({ decide: (request) => hangUntilAborted(request.signal) });
    const result = classifyStep(makeItems(3), makeDeps(model, { signal: controller.signal }));
    await Promise.resolve();
    expect(model.decideCalls).toHaveLength(1);

    controller.abort(REASON);

    await expect(result).rejects.toBe(REASON);
    expect(model.decideCalls).toHaveLength(1);
  });

  it('scores every item as before while the signal has not fired', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({ decide: () => answersFor() });

    const scored = await classifyStep(makeItems(2), makeDeps(model, { signal: controller.signal }));

    expect(scored).toHaveLength(2);
  });
});

describe('classifyStep in generate mode with an abort signal', () => {
  const generateMode = { mode: 'generate' } as const;

  it('hands the signal to the batch call', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({ generate: (request) => answerBatch(request) });

    await classifyStep(
      makeItems(3),
      makeDeps(model, { ...generateMode, signal: controller.signal }),
    );

    expect(model.generateCalls).toHaveLength(1);
    expect(model.generateCalls[0]?.signal).toBe(controller.signal);
  });

  it('calls no model when the signal fired before the start', async () => {
    const controller = new AbortController();
    controller.abort(REASON);
    const model = new FakeModelProvider({ generate: (request) => answerBatch(request) });

    const result = classifyStep(
      makeItems(3),
      makeDeps(model, { ...generateMode, signal: controller.signal }),
    );

    await expect(result).rejects.toBe(REASON);
    expect(model.generateCalls).toEqual([]);
  });

  it('starts no further batch once the signal fires', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({
      generate: (request) => {
        controller.abort(REASON);
        return answerBatch(request);
      },
    });

    const result = classifyStep(
      makeItems(25),
      makeDeps(model, { ...generateMode, signal: controller.signal }),
    );

    await expect(result).rejects.toBe(REASON);
    expect(model.generateCalls).toHaveLength(1);
  });

  it('does not take an aborted batch for items the model left out and retry them', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({
      generate: (request) => hangUntilAborted(request.signal),
    });
    const result = classifyStep(
      makeItems(3),
      makeDeps(model, { ...generateMode, signal: controller.signal }),
    );
    await Promise.resolve();

    controller.abort(REASON);

    await expect(result).rejects.toBe(REASON);
    expect(model.generateCalls).toHaveLength(1);
  });
});

describe('classifyStep with the writer rescore and an abort signal', () => {
  const rescoring = { rescoreWithWriter: true, minRelevance: 1 } as const;

  it('hands the signal to the rescore call', async () => {
    const controller = new AbortController();
    const fake = new FakeModelProvider({
      decide: () => answersFor({ level: 2 }),
      generate: (request) =>
        rescoreReply(
          idsInPrompt(request.prompt).map((itemId) => ({
            itemId,
            relevance: 3,
            area: 'Platform engineering',
            confidence: 'high',
          })),
        ),
    });

    await classifyStep(makeItems(2), makeDeps(fake, { ...rescoring, signal: controller.signal }));

    expect(fake.generateCalls).toHaveLength(1);
    expect(fake.generateCalls[0]?.signal).toBe(controller.signal);
  });

  it('fails the step, and keeps no decider scores, when the rescore call is aborted', async () => {
    const controller = new AbortController();
    const fake = new FakeModelProvider({
      decide: () => answersFor({ level: 2 }),
      generate: (request) => hangUntilAborted(request.signal),
    });
    const result = classifyStep(
      makeItems(2),
      makeDeps(fake, { ...rescoring, signal: controller.signal }),
    );
    await untilFirstGenerate(fake);

    controller.abort(REASON);

    await expect(result).rejects.toBe(REASON);
  });

  it('starts no rescore batch once the signal fired during the decisions', async () => {
    const controller = new AbortController();
    const fake = new FakeModelProvider({
      decide: () => {
        controller.abort(REASON);
        return answersFor({ level: 2 });
      },
      generate: () => rescoreReply([]),
    });

    const result = classifyStep(
      makeItems(1),
      makeDeps(fake, { ...rescoring, signal: controller.signal }),
    );

    await expect(result).rejects.toBe(REASON);
    expect(fake.generateCalls).toEqual([]);
  });
});

/** Lets the step reach its first generate call. */
async function untilFirstGenerate(fake: FakeModelProvider): Promise<void> {
  for (let tick = 0; tick < 50 && fake.generateCalls.length === 0; tick += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
