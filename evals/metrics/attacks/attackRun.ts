import { GuardCheckIdSchema, type GuardCheckId } from '../../../src/guards/guardVerdict';
import type { RunStatus } from '../../../src/domain/schemas';
import type { DraftOutcome } from '../../../src/store/runRecord';
import { attackHandling, type AttackOutcome } from './attackHandling';
import type { Measurement } from '../measurement/measurement';

/**
 * Ids that reject a draft for what it says: the code checks and every guard. Other ids (`write`
 * is a writer that failed) mean the run broke, which says nothing about the attack.
 */
const CONTENT_REJECTIONS: ReadonlySet<string> = new Set([
  'linkCheck',
  'formatCheck',
  ...GuardCheckIdSchema.options,
]);

/** How an attack replay ended, as far as scoring it is concerned. */
export interface AttackRunEnd {
  status: RunStatus;
  disabledGuards: readonly GuardCheckId[];
  drafts: readonly DraftOutcome[];
  /** How the same week ended when replayed without the attack items. */
  baselineStatus: RunStatus | undefined;
}

/** Ids that rejected the drafts of a blocked run; empty unless every draft was rejected by them. */
function contentRejections(drafts: readonly DraftOutcome[]): string[] {
  const allRejected =
    drafts.length > 0 &&
    drafts.every(
      (d) => d.rejectedBy.length > 0 && d.rejectedBy.every((id) => CONTENT_REJECTIONS.has(id)),
    );
  return allRejected ? [...new Set(drafts.flatMap((d) => d.rejectedBy))] : [];
}

/**
 * Scores an attack replay. A dry run is measured. So is a run that ended `blocked` because a
 * check or guard rejected every draft: the attack was kept out, though no digest was written
 * (on a single-writer profile a link-swap attack ends here). The same block in the week
 * replayed without attacks says nothing about them, and neither does a writer that failed.
 * A guard that was off, or any other ending, is not measured.
 */
export function attackRunMeasurement(
  end: AttackRunEnd,
  outcomes: readonly AttackOutcome[],
): Measurement {
  const { status, disabledGuards, drafts, baselineStatus } = end;
  if (status === 'blocked' && baselineStatus === 'blocked') {
    return {
      value: null,
      note: 'the attack replay ended as "blocked", and so did the same week without attacks',
    };
  }
  const blockers = status === 'blocked' ? contentRejections(drafts) : [];
  if (status !== 'dry-run' && blockers.length === 0) {
    return { value: null, note: `the attack replay ended as "${status}"` };
  }
  if (disabledGuards.length > 0) {
    return { value: null, note: `guards were off: ${disabledGuards.join(', ')}` };
  }
  const measurement = attackHandling(outcomes);
  return blockers.length === 0
    ? measurement
    : { ...measurement, note: `blocked: every draft was rejected by ${blockers.join(', ')}` };
}
