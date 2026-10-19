// The run's abort signal reaches every judge call. A judge that fails for its own reason hands the
// win to the first writer in order; an abort is not such a failure: the step rejects, so a run
// told to stop never sends a digest picked by "the judge could not decide".
import { describe, expect, it, vi } from 'vitest';
import { selectStep, type SelectDeps } from './select';
import type { DecisionAnswer } from '../models/ModelProvider';
import type { Logger } from '../shared/telemetry';
import { makeDraft, makeItem } from '../../test/builders';
import { FakeModelProvider, noopLogger } from '../../test/fakes';

const REASON = new Error('run timed out after 2 h');
const CRITERIA = ['accuracy', 'clarity', 'whyItMatters', 'focusFit'] as const;

const answers = (): Record<string, DecisionAnswer> =>
  Object.fromEntries(
    CRITERIA.map((id) => [
      id,
      { type: 'score', level: 3, score: 0.75, probabilities: {}, confidence: 0.9 } as const,
    ]),
  );

const items = [makeItem(), makeItem()];
const drafts = ['alpha', 'beta', 'gamma'].map((writer) => makeDraft(items, writer));

function makeDeps(model: FakeModelProvider, overrides: Partial<SelectDeps> = {}): SelectDeps {
  return {
    model,
    focusAreas: ['AI models and tooling'],
    writerOrder: ['alpha', 'beta', 'gamma'],
    logger: noopLogger,
    ...overrides,
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

describe('selectStep with an abort signal', () => {
  it('hands the signal to every judge call', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({ decide: answers });

    await selectStep(drafts, items, makeDeps(model, { signal: controller.signal }));

    expect(model.decideCalls).toHaveLength(3);
    expect(model.decideCalls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  it('throws the reason and calls no judge when the signal fired before the start', async () => {
    const controller = new AbortController();
    controller.abort(REASON);
    const model = new FakeModelProvider({ decide: answers });

    const result = selectStep(drafts, items, makeDeps(model, { signal: controller.signal }));

    await expect(result).rejects.toBe(REASON);
    expect(model.decideCalls).toEqual([]);
  });

  it('starts no further judge call once the signal fires, and picks no winner', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({
      decide: () => {
        controller.abort(REASON);
        return answers();
      },
    });

    const result = selectStep(drafts, items, makeDeps(model, { signal: controller.signal }));

    await expect(result).rejects.toBe(REASON);
    expect(model.decideCalls).toHaveLength(1);
  });

  it('rejects, with no fallback winner and no warning, when the call in flight is aborted', async () => {
    const controller = new AbortController();
    const warn = vi.fn();
    const logger: Logger = { ...noopLogger, warn, child: () => logger };
    const model = new FakeModelProvider({ decide: (request) => hangUntilAborted(request.signal) });
    const result = selectStep(
      drafts,
      items,
      makeDeps(model, { signal: controller.signal, logger }),
    );
    await Promise.resolve();
    expect(model.decideCalls).toHaveLength(1);

    controller.abort(REASON);

    await expect(result).rejects.toBe(REASON);
    expect(warn).not.toHaveBeenCalled();
  });

  it('still falls back to the first writer in order when the judge fails on its own', async () => {
    const controller = new AbortController();
    const model = new FakeModelProvider({
      decide: () => {
        throw new Error('judge model crashed');
      },
    });

    const result = await selectStep(drafts, items, makeDeps(model, { signal: controller.signal }));

    expect(result.winner.writer).toBe('alpha');
    expect(result.judged).toBe(false);
  });

  it('takes a lone draft without a judge call even when the signal fired', async () => {
    const controller = new AbortController();
    controller.abort(REASON);
    const [only] = drafts;
    const model = new FakeModelProvider({ decide: answers });

    const result = await selectStep([only!], items, makeDeps(model, { signal: controller.signal }));

    expect(result.winner).toBe(only);
    expect(model.decideCalls).toEqual([]);
  });
});
