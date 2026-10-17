import { describe, expect, it, vi } from 'vitest';
import {
  guardInputStep,
  type GuardInputDeps,
  type GuardInputOutput,
} from '../../../src/core/steps/guardInput.js';
import { GUARD_CONCURRENCY } from '../../../src/core/steps/guardRun.js';
import type { GuardCheckId, GuardVerdict, Item } from '../../../src/core/schemas.js';
import type { InputGuard } from '../../../src/ports/Guard.js';
import { DigestError } from '../../../src/shared/errors.js';
import { makeConfig, makeItem } from '../../builders.js';
import { FakeInputGuard, noopLogger } from '../../fakes/index.js';

type InputConfig = GuardInputDeps['config'];

function inputConfig(
  overrides: Partial<Omit<InputConfig, 'checks'>> & {
    checks?: Partial<InputConfig['checks']>;
  } = {},
): InputConfig {
  const base = makeConfig().guards.input;
  return { ...base, ...overrides, checks: { ...base.checks, ...overrides.checks } };
}

function makeTestLogger() {
  const warn = vi.fn();
  return { logger: { ...noopLogger, warn }, warn };
}

function makeDeps(
  guards: readonly InputGuard[],
  config: InputConfig = inputConfig(),
): GuardInputDeps {
  return { guards, config, logger: noopLogger };
}

function items(count: number): Item[] {
  return Array.from({ length: count }, () => makeItem());
}

const flagging = (...flagged: readonly Item[]) => {
  const ids = new Set(flagged.map((item) => item.id));
  return (item: Item) => ids.has(item.id);
};

const ids = (list: readonly Item[]): string[] => list.map((item) => item.id);

/** Records `${guardId}:${itemId}` in a log shared by several guards, to assert call order. */
class RecordingGuard implements InputGuard {
  constructor(
    readonly id: GuardCheckId,
    private readonly log: string[],
    private readonly flag: (item: Item) => boolean = () => false,
  ) {}

  checkItem(item: Item): Promise<GuardVerdict> {
    this.log.push(`${this.id}:${item.id}`);
    return Promise.resolve({ check: this.id, flagged: this.flag(item) });
  }
}

class ThrowingGuard implements InputGuard {
  readonly calls: Item[] = [];
  constructor(
    readonly id: GuardCheckId,
    private readonly error: Error,
  ) {}

  checkItem(item: Item): Promise<GuardVerdict> {
    this.calls.push(item);
    return Promise.reject(this.error);
  }
}

/** Takes two microtask turns per call, so calls overlap whenever the step lets them. */
class OverlapGuard implements InputGuard {
  peak = 0;
  private inFlight = 0;
  constructor(
    readonly id: GuardCheckId,
    private readonly flag: (item: Item) => boolean = () => false,
  ) {}

  async checkItem(item: Item): Promise<GuardVerdict> {
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    await Promise.resolve();
    await Promise.resolve();
    this.inFlight -= 1;
    return { check: this.id, flagged: this.flag(item) };
  }
}

describe('guardInputStep', () => {
  describe('mode any', () => {
    it('drops an item flagged by either guard and keeps the rest in input order', async () => {
      const [a, b, c, d] = items(4) as [Item, Item, Item, Item];
      const clef = new FakeInputGuard('clefPolicy', flagging(a));
      const granite = new FakeInputGuard('graniteRisk', flagging(c));

      const out = await guardInputStep([a, b, c, d], makeDeps([clef, granite]));

      expect(ids(out.kept)).toEqual([b.id, d.id]);
      expect(ids(out.dropped.map((entry) => entry.item))).toEqual([a.id, c.id]);
      expect(out.disabledChecks).toEqual([]);
    });

    it('lists dropped items in input order even when a later guard flags the earlier one', async () => {
      const [a, b, c] = items(3) as [Item, Item, Item];
      const clef = new FakeInputGuard('clefPolicy', flagging(c));
      const granite = new FakeInputGuard('graniteRisk', flagging(a));

      const out = await guardInputStep([a, b, c], makeDeps([clef, granite]));

      expect(ids(out.dropped.map((entry) => entry.item))).toEqual([a.id, c.id]);
    });

    it('sends only the items guard A did not flag to guard B', async () => {
      const [a, b, c] = items(3) as [Item, Item, Item];
      const clef = new FakeInputGuard('clefPolicy', flagging(a));
      const granite = new FakeInputGuard('graniteRisk');

      await guardInputStep([a, b, c], makeDeps([clef, granite]));

      expect(clef.calls).toEqual([a, b, c]);
      expect(granite.calls).toEqual([b, c]);
    });

    it('drops an item flagged by both guards once, with the verdict of the guard that flagged it first', async () => {
      const [a] = items(1) as [Item];
      const clef = new FakeInputGuard('clefPolicy', flagging(a));
      const granite = new FakeInputGuard('graniteRisk', flagging(a));

      const out = await guardInputStep([a], makeDeps([clef, granite]));

      expect(out.dropped).toEqual([
        { item: a, verdicts: [{ check: 'clefPolicy', flagged: true }] },
      ]);
      expect(granite.calls).toEqual([]);
    });
  });

  describe('mode all', () => {
    const config = inputConfig({ mode: 'all' });

    it('drops only items flagged by every enabled guard', async () => {
      const [a, b, c, d] = items(4) as [Item, Item, Item, Item];
      const clef = new FakeInputGuard('clefPolicy', flagging(a, b));
      const granite = new FakeInputGuard('graniteRisk', flagging(b, c));

      const out = await guardInputStep([a, b, c, d], makeDeps([clef, granite], config));

      expect(ids(out.kept)).toEqual([a.id, c.id, d.id]);
      expect(ids(out.dropped.map((entry) => entry.item))).toEqual([b.id]);
    });

    it('sends only the items guard A flagged to guard B', async () => {
      const [a, b, c] = items(3) as [Item, Item, Item];
      const clef = new FakeInputGuard('clefPolicy', flagging(a, c));
      const granite = new FakeInputGuard('graniteRisk');

      const out = await guardInputStep([a, b, c], makeDeps([clef, granite], config));

      expect(clef.calls).toEqual([a, b, c]);
      expect(granite.calls).toEqual([a, c]);
      expect(ids(out.kept)).toEqual([a.id, b.id, c.id]);
      expect(out.dropped).toEqual([]);
    });

    it('drops what the only enabled guard flags', async () => {
      const [a, b] = items(2) as [Item, Item];
      const clef = new FakeInputGuard('clefPolicy', flagging(a));
      const single = inputConfig({ mode: 'all', checks: { graniteRisk: false } });

      const out = await guardInputStep([a, b], makeDeps([clef], single));

      expect(ids(out.kept)).toEqual([b.id]);
      expect(ids(out.dropped.map((entry) => entry.item))).toEqual([a.id]);
    });
  });

  describe('disabled checks', () => {
    it('reports a check switched off in config and never calls its guard', async () => {
      const list = items(2);
      const clef = new FakeInputGuard('clefPolicy');
      const granite = new FakeInputGuard('graniteRisk');
      const config = inputConfig({ checks: { graniteRisk: false } });

      const out = await guardInputStep(list, makeDeps([clef, granite], config));

      expect(out.disabledChecks).toEqual(['graniteRisk']);
      expect(granite.calls).toEqual([]);
      expect(clef.calls).toEqual(list);
    });

    it('reports every check and keeps every item when input guards are disabled', async () => {
      const list = items(3);
      const clef = new FakeInputGuard('clefPolicy', () => true);
      const granite = new FakeInputGuard('graniteRisk', () => true);

      const out = await guardInputStep(
        list,
        makeDeps([clef, granite], inputConfig({ enabled: false })),
      );

      expect(out).toEqual<GuardInputOutput>({
        kept: list,
        dropped: [],
        disabledChecks: ['clefPolicy', 'graniteRisk'],
      });
      expect([...clef.calls, ...granite.calls]).toEqual([]);
    });

    it('reports an enabled check whose guard is missing and logs a warning', async () => {
      const [a, b] = items(2) as [Item, Item];
      const clef = new FakeInputGuard('clefPolicy', flagging(a));
      const { logger, warn } = makeTestLogger();

      const out = await guardInputStep([a, b], { guards: [clef], config: inputConfig(), logger });

      expect(out.disabledChecks).toEqual(['graniteRisk']);
      expect(ids(out.kept)).toEqual([b.id]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('graniteRisk'), {
        check: 'graniteRisk',
      });
    });

    it('does not warn about a check that config switched off', async () => {
      const { logger, warn } = makeTestLogger();
      const config = inputConfig({ checks: { graniteRisk: false } });

      await guardInputStep(items(1), {
        guards: [new FakeInputGuard('clefPolicy')],
        config,
        logger,
      });

      expect(warn).not.toHaveBeenCalled();
    });

    it('lists disabled checks in config order, not guard order', async () => {
      const config = inputConfig({ checks: { clefPolicy: false, graniteRisk: false } });

      const out = await guardInputStep(items(1), makeDeps([], config));

      expect(out.disabledChecks).toEqual(['clefPolicy', 'graniteRisk']);
    });

    it('ignores a guard that is not an input check', async () => {
      const list = items(2);
      const foreign = new FakeInputGuard('graniteGroundedness', () => true);
      const clef = new FakeInputGuard('clefPolicy');
      const granite = new FakeInputGuard('graniteRisk');

      const out = await guardInputStep(list, makeDeps([foreign, clef, granite]));

      expect(foreign.calls).toEqual([]);
      expect(out.kept).toEqual(list);
      expect(out.disabledChecks).toEqual([]);
    });

    it('keeps everything and runs nothing when no check is enabled', async () => {
      const list = items(2);
      const clef = new FakeInputGuard('clefPolicy', () => true);
      const config = inputConfig({ checks: { clefPolicy: false, graniteRisk: false } });

      const out = await guardInputStep(list, makeDeps([clef], config));

      expect(out).toEqual<GuardInputOutput>({
        kept: list,
        dropped: [],
        disabledChecks: ['clefPolicy', 'graniteRisk'],
      });
      expect(clef.calls).toEqual([]);
    });

    it('keeps everything in mode all too when no check is enabled', async () => {
      const list = items(2);
      const config = inputConfig({
        mode: 'all',
        checks: { clefPolicy: false, graniteRisk: false },
      });

      const out = await guardInputStep(list, makeDeps([new FakeInputGuard('clefPolicy')], config));

      expect(out.kept).toEqual(list);
      expect(out.dropped).toEqual([]);
    });
  });

  describe('call order', () => {
    it('runs guard by guard: every item through A before any item reaches B', async () => {
      const [a, b, c] = items(3) as [Item, Item, Item];
      const log: string[] = [];
      const clef = new RecordingGuard('clefPolicy', log);
      const granite = new RecordingGuard('graniteRisk', log);

      await guardInputStep([a, b, c], makeDeps([granite, clef]));

      expect(log).toEqual([
        `clefPolicy:${a.id}`,
        `clefPolicy:${b.id}`,
        `clefPolicy:${c.id}`,
        `graniteRisk:${a.id}`,
        `graniteRisk:${b.id}`,
        `graniteRisk:${c.id}`,
      ]);
    });

    it('stays guard-major in mode all', async () => {
      const [a, b] = items(2) as [Item, Item];
      const log: string[] = [];
      const clef = new RecordingGuard('clefPolicy', log, () => true);
      const granite = new RecordingGuard('graniteRisk', log);

      await guardInputStep([a, b], makeDeps([clef, granite], inputConfig({ mode: 'all' })));

      expect(log).toEqual([
        `clefPolicy:${a.id}`,
        `clefPolicy:${b.id}`,
        `graniteRisk:${a.id}`,
        `graniteRisk:${b.id}`,
      ]);
    });
  });

  describe('concurrency', () => {
    it('checks one item at a time within a guard', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const probe: InputGuard = {
        id: 'clefPolicy',
        async checkItem(): Promise<GuardVerdict> {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return { check: 'clefPolicy', flagged: false };
        },
      };
      const config = inputConfig({ checks: { graniteRisk: false } });

      await guardInputStep(items(3), makeDeps([probe], config));

      expect(maxInFlight).toBe(1);
    });

    it('checks no more items at once than GUARD_CONCURRENCY when deps give no limit', async () => {
      const guard = new OverlapGuard('clefPolicy');
      const config = inputConfig({ checks: { graniteRisk: false } });

      await guardInputStep(items(6), makeDeps([guard], config));

      expect(guard.peak).toBe(Math.min(GUARD_CONCURRENCY, 6));
    });

    it('checks up to deps.concurrency items at once within a guard', async () => {
      const guard = new OverlapGuard('clefPolicy');
      const config = inputConfig({ checks: { graniteRisk: false } });

      await guardInputStep(items(6), { ...makeDeps([guard], config), concurrency: 3 });

      expect(guard.peak).toBe(3);
    });

    it('gives the same kept, dropped and verdicts at every limit', async () => {
      const list = items(7);
      const [a, b, c, d] = list as [Item, Item, Item, Item, ...Item[]];
      const run = (concurrency: number) =>
        guardInputStep(list, {
          ...makeDeps([
            new OverlapGuard('clefPolicy', flagging(a, d)),
            new OverlapGuard('graniteRisk', flagging(b, c)),
          ]),
          concurrency,
        });

      const serial = await run(1);

      expect(await run(2)).toEqual(serial);
      expect(await run(4)).toEqual(serial);
      expect(ids(serial.dropped.map((entry) => entry.item))).toEqual([a.id, b.id, c.id, d.id]);
    });

    it('rejects a limit that is not a whole number of at least 1, before any call', async () => {
      const clef = new FakeInputGuard('clefPolicy');

      await expect(
        guardInputStep(items(2), { ...makeDeps([clef]), concurrency: 0 }),
      ).rejects.toThrow(DigestError);

      expect(clef.calls).toEqual([]);
    });

    it('rejects with the error of a failing call at a higher limit and starts no later guard', async () => {
      const error = new Error('ollama unreachable');
      const clef = new ThrowingGuard('clefPolicy', error);
      const granite = new FakeInputGuard('graniteRisk');

      await expect(
        guardInputStep(items(5), { ...makeDeps([clef, granite]), concurrency: 2 }),
      ).rejects.toBe(error);

      expect(clef.calls).toHaveLength(2);
      expect(granite.calls).toEqual([]);
    });
  });

  describe('verdicts', () => {
    it('records the verdicts of every guard that looked at a dropped item', async () => {
      const [a] = items(1) as [Item];
      const clef = new FakeInputGuard('clefPolicy');
      const granite = new FakeInputGuard('graniteRisk', flagging(a));

      const out = await guardInputStep([a], makeDeps([clef, granite]));

      expect(out.dropped).toEqual([
        {
          item: a,
          verdicts: [
            { check: 'clefPolicy', flagged: false },
            { check: 'graniteRisk', flagged: true },
          ],
        },
      ]);
    });

    it('records every flagging verdict for an item dropped by all guards', async () => {
      const [a] = items(1) as [Item];
      const clef = new FakeInputGuard('clefPolicy', flagging(a));
      const granite = new FakeInputGuard('graniteRisk', flagging(a));

      const out = await guardInputStep(
        [a],
        makeDeps([clef, granite], inputConfig({ mode: 'all' })),
      );

      expect(out.dropped[0]?.verdicts).toEqual([
        { check: 'clefPolicy', flagged: true },
        { check: 'graniteRisk', flagged: true },
      ]);
    });

    it('passes through probability and reason from the guard', async () => {
      const [a] = items(1) as [Item];
      const verdict: GuardVerdict = {
        check: 'clefPolicy',
        flagged: true,
        probability: 0.93,
        reason: 'addresses the AI',
      };
      const guard: InputGuard = { id: 'clefPolicy', checkItem: () => Promise.resolve(verdict) };

      const out = await guardInputStep([a], makeDeps([guard]));

      expect(out.dropped[0]?.verdicts).toEqual([verdict]);
    });
  });

  describe('logging', () => {
    function spyLogger() {
      const spies = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const logger = { ...noopLogger, ...spies };
      const logged = (): string =>
        JSON.stringify(Object.values(spies).map((spy) => spy.mock.calls));
      return { logger, spies, logged };
    }

    it('logs the id and flagging checks of a dropped item', async () => {
      const [a] = items(1) as [Item];
      const { logger, spies } = spyLogger();

      await guardInputStep([a], {
        guards: [new FakeInputGuard('clefPolicy', flagging(a))],
        config: inputConfig({ checks: { graniteRisk: false } }),
        logger,
      });

      expect(spies.debug).toHaveBeenCalledWith(expect.any(String), {
        itemId: a.id,
        flaggedBy: ['clefPolicy'],
      });
    });

    it('never logs item text, whether the item was dropped or a guard was missing', async () => {
      const [a, b] = items(2) as [Item, Item];
      const { logger, logged } = spyLogger();

      await guardInputStep([a, b], {
        guards: [new FakeInputGuard('clefPolicy', flagging(a))],
        config: inputConfig(),
        logger,
      });

      for (const item of [a, b]) {
        for (const text of [item.title, item.summary, item.url]) {
          expect(logged()).not.toContain(text);
        }
      }
    });
  });

  describe('errors and inputs', () => {
    it('rejects when a guard throws and does not start the next guard', async () => {
      const error = new Error('ollama unreachable');
      const clef = new ThrowingGuard('clefPolicy', error);
      const granite = new FakeInputGuard('graniteRisk');

      await expect(guardInputStep(items(2), makeDeps([clef, granite]))).rejects.toBe(error);

      expect(granite.calls).toEqual([]);
    });

    it('rejects when the second guard throws, instead of dropping or keeping silently', async () => {
      const error = new Error('model not installed');
      const clef = new FakeInputGuard('clefPolicy');
      const granite = new ThrowingGuard('graniteRisk', error);

      await expect(guardInputStep(items(2), makeDeps([clef, granite]))).rejects.toBe(error);
    });

    it('returns empty results for no items without calling a guard', async () => {
      const clef = new FakeInputGuard('clefPolicy');
      const granite = new FakeInputGuard('graniteRisk');

      const out = await guardInputStep([], makeDeps([clef, granite]));

      expect(out).toEqual<GuardInputOutput>({ kept: [], dropped: [], disabledChecks: [] });
      expect(clef.calls).toEqual([]);
    });

    it('does not mutate frozen inputs while guards run', async () => {
      const [a, b, c] = items(3) as [Item, Item, Item];
      const list: readonly Item[] = Object.freeze([a, b, c]);
      const config = inputConfig({ mode: 'all' });
      Object.freeze(config.checks);
      Object.freeze(config);
      const clef = new FakeInputGuard('clefPolicy', flagging(a, b));
      const granite = new FakeInputGuard('graniteRisk', flagging(b));

      const out = await guardInputStep(list, makeDeps(Object.freeze([clef, granite]), config));

      expect(ids(out.kept)).toEqual([a.id, c.id]);
      expect(ids(out.dropped.map((entry) => entry.item))).toEqual([b.id]);
    });

    it('does not mutate its inputs and returns a new array when nothing runs', async () => {
      const list: readonly Item[] = Object.freeze(items(2));
      const config = Object.freeze(inputConfig({ enabled: false }));

      const out = await guardInputStep(list, makeDeps([], config));

      expect(out.kept).toEqual(list);
      expect(out.kept).not.toBe(list);
    });
  });
});
