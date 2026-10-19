// A finished Replay without running one: for tests of what reads a replay (scoring/, replay/).
import { makeRunRecord } from '../../../test/builders';
import type { Replay } from '../replay';

/** A replay of 2026-W40 that served nothing, wrote no digest and logged no verdicts. */
export function makeReplay(overrides: Partial<Replay> = {}): Replay {
  const weekId = overrides.weekId ?? '2026-W40';
  return {
    weekId,
    items: [],
    markdown: undefined,
    record: makeRunRecord({ runId: weekId, status: 'dry-run', dryRun: true }),
    durationMs: 1000,
    inputVerdicts: [],
    outputVerdicts: [],
    served: new Set<string>(),
    ...overrides,
  };
}
