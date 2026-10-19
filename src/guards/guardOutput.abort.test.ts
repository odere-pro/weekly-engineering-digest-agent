import { describe, expect, it } from 'vitest';
import { guardOutputStep, type GuardOutputDeps } from './guardOutput';
import type { GuardCallOptions, OutputGuard } from './Guard';
import type { GuardCheckId, GuardVerdict } from './guardVerdict';
import type { Draft, Item } from '../domain/schemas';
import { makeConfig, makeDraft, makeItem } from '../../test/builders';
import { noopLogger } from '../../test/fakes';

const REASON = new Error('run timed out after 2 h');
const SOURCES: readonly Item[] = [makeItem(), makeItem()];

/** Passes every draft; remembers the options of each call and can fire a hook on a call. */
class SignalGuard implements OutputGuard {
  readonly calls: { draft: Draft; options: GuardCallOptions | undefined }[] = [];
  constructor(
    readonly id: GuardCheckId,
    private readonly onCall: () => void = () => undefined,
  ) {}

  checkDraft(
    draft: Draft,
    _sources: readonly Item[],
    options?: GuardCallOptions,
  ): Promise<GuardVerdict> {
    this.calls.push({ draft, options });
    this.onCall();
    return Promise.resolve({ check: this.id, flagged: false });
  }
}

/** A model call that ends only when its signal fires, as a forwarded Ollama call does. */
class HangingGuard implements OutputGuard {
  calls = 0;
  constructor(readonly id: GuardCheckId) {}

  async checkDraft(
    _draft: Draft,
    _sources: readonly Item[],
    options?: GuardCallOptions,
  ): Promise<GuardVerdict> {
    this.calls += 1;
    await new Promise<void>((resolve) => {
      options?.signal?.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    });
    options?.signal?.throwIfAborted();
    return { check: this.id, flagged: false };
  }
}

function makeDeps(
  guards: readonly OutputGuard[],
  signal: AbortSignal | undefined,
): GuardOutputDeps {
  return { guards, config: makeConfig().guards.output, logger: noopLogger, signal };
}

const threeDrafts = (): Draft[] =>
  ['a', 'b', 'c'].map((name) => makeDraft(SOURCES, `writer-${name}`));

describe('guardOutputStep with an abort signal', () => {
  it('hands the signal to every guard call', async () => {
    const controller = new AbortController();
    const grounding = new SignalGuard('graniteGroundedness');
    const rubric = new SignalGuard('clefRubric');

    await guardOutputStep(threeDrafts(), SOURCES, makeDeps([grounding, rubric], controller.signal));

    for (const guard of [grounding, rubric]) {
      expect(guard.calls).toHaveLength(3);
      expect(guard.calls.every((call) => call.options?.signal === controller.signal)).toBe(true);
    }
  });

  it('throws the reason and calls no guard when the signal fired before the start', async () => {
    const controller = new AbortController();
    controller.abort(REASON);
    const grounding = new SignalGuard('graniteGroundedness');

    const result = guardOutputStep(
      threeDrafts(),
      SOURCES,
      makeDeps([grounding], controller.signal),
    );

    await expect(result).rejects.toBe(REASON);
    expect(grounding.calls).toEqual([]);
  });

  it('starts no further call once the signal fires, and gives no verdict', async () => {
    const controller = new AbortController();
    const grounding = new SignalGuard('graniteGroundedness', () => {
      controller.abort(REASON);
    });
    const rubric = new SignalGuard('clefRubric');

    const result = guardOutputStep(
      threeDrafts(),
      SOURCES,
      makeDeps([grounding, rubric], controller.signal),
    );

    await expect(result).rejects.toBe(REASON);
    expect(grounding.calls).toHaveLength(1);
    expect(rubric.calls).toEqual([]);
  });

  it('fails the step, and rejects no draft, when the call in flight is aborted', async () => {
    const controller = new AbortController();
    const grounding = new HangingGuard('graniteGroundedness');
    const result = guardOutputStep(
      threeDrafts(),
      SOURCES,
      makeDeps([grounding], controller.signal),
    );
    await Promise.resolve();
    expect(grounding.calls).toBe(1);

    controller.abort(REASON);

    await expect(result).rejects.toBe(REASON);
    expect(grounding.calls).toBe(1);
  });

  it('checks every draft as before while the signal has not fired', async () => {
    const controller = new AbortController();
    const drafts = threeDrafts();
    const grounding = new SignalGuard('graniteGroundedness');

    const out = await guardOutputStep(drafts, SOURCES, makeDeps([grounding], controller.signal));

    expect(out.passed).toEqual(drafts);
    expect(out.rejected).toEqual([]);
  });
});
