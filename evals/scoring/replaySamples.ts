import type { DigestSample } from '../metrics/digest/digestSample';
import { digestItemIds } from '../metrics/digest/parseDigest';
import { noDigestCause, type ReplayEnd } from '../metrics/guards/guardRealBlocks';
import type { WeekHits } from '../metrics/ranking/labelHits';
import type { Replay } from '../replay/replay';
import type { WeekRun } from './types';

/** The ids of the items the replay's digest links to; none without a digest. */
export const idsOf = (run: Replay): string[] =>
  run.markdown === undefined ? [] : digestItemIds(run.markdown, run.items);

/** A replay as the link, format and fact metrics read it. */
export const sampleOf = (run: Replay): DigestSample => ({
  weekId: run.weekId,
  markdown: run.markdown,
  items: run.items,
  disabledGuards: run.record.disabledGuards,
  ...(run.markdown === undefined ? { cause: noDigestCause(run.record) } : {}),
});

/** A replay as `guardRealBlocks` reads it: how the run ended and what the output guards said. */
export const replayEndOf = (run: Replay): ReplayEnd => ({
  label: run.weekId,
  status: run.record.status,
  drafts: run.record.drafts,
  outputVerdicts: run.outputVerdicts.map(({ verdict }) => ({
    check: verdict.check,
    flagged: verdict.flagged,
    ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
  })),
});

/** One week for the recall and leak metrics: its labels, its digest and what the replay served. */
export function hitsOf({ week, run }: WeekRun): WeekHits {
  return {
    mustInclude: week.labels.mustInclude,
    mustExclude: week.labels.mustExclude,
    digestItemIds: idsOf(run),
    visibleIds: run.served,
  };
}
