import { describe, expect, it } from 'vitest';
import { guardInputStep, type GuardInputDeps } from './guardInput';
import type { GuardCallOptions, InputGuard } from './Guard';
import type { GuardCheckId, GuardVerdict } from './guardVerdict';
import type { Item } from '../domain/schemas';
import { makeConfig, makeItem } from '../../test/builders';
import { noopLogger } from '../../test/fakes';

const REASON = new Error('run timed out after 2 h');

/** Passes every item; remembers the options of each call and can fire a hook on a call. */
class SignalGuard implements InputGuard {
  readonly calls: { item: Item; options: GuardCallOptions | undefined }[] = [];
  constructor(
    readonly id: GuardCheckId,
    private readonly onCall: () => void = () => undefined,
  ) {}

  checkItem(item: Item, options?: GuardCallOptions): Promise<GuardVerdict> {
    this.calls.push({ item, options });
    this.onCall();
    return Promise.resolve({ check: this.id, flagged: false });
  }
}

/** A model call that ends only when its signal fires, as a forwarded Ollama call does. */
class HangingGuard implements InputGuard {
  calls = 0;
  constructor(readonly id: GuardCheckId) {}

  async checkItem(_item: Item, options?: GuardCallOptions): Promise<GuardVerdict> {
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
  guards: readonly InputGuard[],
  signal: AbortSignal | undefined,
  mode: 'any' | 'all' = 'any',
): GuardInputDeps {
  const config = makeConfig().guards.input;
  return { guards, config: { ...config, mode }, logger: noopLogger, signal };
}

const threeItems = (): Item[] => [makeItem(), makeItem(), makeItem()];

describe('guardInputStep with an abort signal', () => {
  it('hands the signal to every guard call, the rule guard included', async () => {
    const controller = new AbortController();
    const rule = new SignalGuard('ruleInjection');
    const clef = new SignalGuard('clefPolicy');
    const granite = new SignalGuard('graniteRisk');

    await guardInputStep(threeItems(), makeDeps([rule, clef, granite], controller.signal));

    for (const guard of [rule, clef, granite]) {
      expect(guard.calls).toHaveLength(3);
      expect(guard.calls.every((call) => call.options?.signal === controller.signal)).toBe(true);
    }
  });

  it('throws the reason and calls no guard when the signal fired before the start', async () => {
    const controller = new AbortController();
    controller.abort(REASON);
    const rule = new SignalGuard('ruleInjection');
    const clef = new SignalGuard('clefPolicy');

    const result = guardInputStep(threeItems(), makeDeps([rule, clef], controller.signal));

    await expect(result).rejects.toBe(REASON);
    expect(rule.calls).toEqual([]);
    expect(clef.calls).toEqual([]);
  });

  it('starts no further call once the signal fires, and gives no verdict', async () => {
    const controller = new AbortController();
    const clef = new SignalGuard('clefPolicy', () => {
      controller.abort(REASON);
    });
    const granite = new SignalGuard('graniteRisk');

    const result = guardInputStep(threeItems(), makeDeps([clef, granite], controller.signal));

    await expect(result).rejects.toBe(REASON);
    expect(clef.calls).toHaveLength(1);
    expect(granite.calls).toEqual([]);
  });

  it('starts no model guard when the signal fires during the rule guard pass', async () => {
    const controller = new AbortController();
    const rule = new SignalGuard('ruleInjection', () => {
      controller.abort(REASON);
    });
    const clef = new SignalGuard('clefPolicy');

    const result = guardInputStep(threeItems(), makeDeps([rule, clef], controller.signal, 'all'));

    await expect(result).rejects.toBe(REASON);
    expect(clef.calls).toEqual([]);
  });

  it('fails the step, and drops no item, when the call in flight is aborted', async () => {
    const controller = new AbortController();
    const clef = new HangingGuard('clefPolicy');
    const result = guardInputStep(threeItems(), makeDeps([clef], controller.signal));
    await Promise.resolve();
    expect(clef.calls).toBe(1);

    controller.abort(REASON);

    await expect(result).rejects.toBe(REASON);
    expect(clef.calls).toBe(1);
  });

  it('checks every item as before while the signal has not fired', async () => {
    const controller = new AbortController();
    const items = threeItems();
    const clef = new SignalGuard('clefPolicy');

    const out = await guardInputStep(items, makeDeps([clef], controller.signal));

    expect(out.kept).toEqual(items);
    expect(out.dropped).toEqual([]);
  });
});
