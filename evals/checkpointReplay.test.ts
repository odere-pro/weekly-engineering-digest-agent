import { describe, expect, it } from 'vitest';
import { makeItem, makeRunRecord } from '../test/builders';
import { replayCodec } from './checkpointReplay';
import type { Replay } from './replay/replay';

function replayOf(overrides: Partial<Replay> = {}): Replay {
  const item = makeItem();
  return {
    weekId: '2026-W42',
    items: [item],
    markdown: '# Week 2026-W42\n',
    record: makeRunRecord(),
    durationMs: 1200,
    inputVerdicts: [],
    outputVerdicts: [],
    served: new Set([item.id]),
    ...overrides,
  };
}

describe('replayCodec', () => {
  it('saves a replay as plain JSON and reads it back, the served ids as a set again', () => {
    const replay = replayOf();

    const saved: unknown = JSON.parse(JSON.stringify(replayCodec.encode(replay)));

    expect(replayCodec.decode(saved)).toEqual(replay);
  });

  it('keeps a replay with no Markdown (a run that wrote none)', () => {
    const replay = replayOf({ markdown: undefined });

    const saved: unknown = JSON.parse(JSON.stringify(replayCodec.encode(replay)));

    expect(replayCodec.decode(saved)?.markdown).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['text', 'not a replay'],
    ['a replay without a record', { weekId: '2026-W42', items: [], served: [] }],
    ['a replay with a negative duration', { ...replayOf(), durationMs: -1, served: [] }],
  ])('reads %s as no saved result, so the week is computed again', (_name, saved) => {
    expect(replayCodec.decode(saved)).toBeUndefined();
  });
});
