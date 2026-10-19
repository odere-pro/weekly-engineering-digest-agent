// The classify step logs how far it is: clef took 12 to 35 s an item on a 32 GB laptop
// (2026-10-19), so 147 items are about half an hour with nothing else on screen.
import { describe, expect, it, vi } from 'vitest';
import { classifyStep } from './classify';
import { answersFor, makeDeps, makeItems } from './__fixtures__/classifyKit';
import type { LogFields } from '../shared/telemetry';
import { FakeModelProvider, noopLogger } from '../../test/fakes';
import { steppedClock } from '../shared/__fixtures__/steppedClock';

function setup(secondsPerItem: number) {
  const time = steppedClock();
  const info = vi.fn<(message: string, fields?: LogFields) => void>();
  const model = new FakeModelProvider({
    decide: () => {
      time.advance(secondsPerItem * 1_000);
      return answersFor();
    },
  });
  const deps = makeDeps(model, { logger: { ...noopLogger, info }, clock: time.clock });
  const lines = () =>
    info.mock.calls.filter(([message]) => message === 'Progress').map(([, fields]) => fields);
  return { deps, lines };
}

describe('classifyStep progress', () => {
  it('logs every 25 items and at the end, with the median call and the time left', async () => {
    const { deps, lines } = setup(2);

    await classifyStep(makeItems(60), deps);

    expect(lines()).toEqual([
      expect.objectContaining({
        label: 'classify',
        done: 25,
        total: 60,
        medianMs: 2_000,
        etaMs: 70_000,
      }),
      expect.objectContaining({ label: 'classify', done: 50, total: 60, etaMs: 20_000 }),
      expect.objectContaining({ label: 'classify', done: 60, total: 60, etaMs: 0 }),
    ]);
  });

  it('logs by the minute when a call is slow, as clef was', async () => {
    const { deps, lines } = setup(15);

    await classifyStep(makeItems(10), deps);

    expect(lines().map((fields) => fields?.done)).toEqual([4, 8, 10]);
    expect(lines()[0]).toMatchObject({ eta: '1 min 30 s', medianMs: 15_000, etaMs: 90_000 });
  });

  it('logs nothing for an empty input', async () => {
    const { deps, lines } = setup(1);

    await classifyStep([], deps);

    expect(lines()).toEqual([]);
  });

  it('still logs the mode and the item count once at the end', async () => {
    const { deps } = setup(1);
    const info = vi.fn();

    await classifyStep(makeItems(3), { ...deps, logger: { ...noopLogger, info } });

    expect(info).toHaveBeenCalledWith('Classified items', { mode: 'decide', count: 3 });
  });
});
