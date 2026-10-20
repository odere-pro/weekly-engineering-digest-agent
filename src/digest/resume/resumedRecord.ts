import type { DeliveryId } from '../../delivery/deliveryId';
import { DigestError } from '../../shared/errors';
import type { RunRecord } from '../../store/runRecord';
import { recordError } from '../ending/runFiles/errorFile';
import { DELIVERY_CUT_OFF, saveProgress } from '../ending/saveProgress';
import type { OnDelivered } from '../ending/shipping/shipping';
import type { EndingContext, Failure } from '../ending/types';

/** What a resume's records need from the run: the ending context and when the resume began. */
type ResumeRecordContext = EndingContext & { readonly startedAt: Date };

/** How a resume ended, or how far it got. */
export interface ResumeOutcome {
  readonly deliveredTo: readonly DeliveryId[];
  readonly failure: Failure | undefined;
  readonly finishedAt: Date;
  readonly timings: RunRecord['timings'];
}

/** The previous run's record with the outcome, channels and timings of this resume. */
export function resumedRecord(
  ctx: ResumeRecordContext,
  previous: RunRecord,
  outcome: ResumeOutcome,
): RunRecord {
  const { error: _previousError, ...kept } = previous;
  const { failure } = outcome;
  return {
    ...kept,
    status: failure ? 'failed' : 'sent',
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: outcome.finishedAt.toISOString(),
    timings: outcome.timings,
    deliveredTo: [...outcome.deliveredTo],
    ...(failure && { error: recordError(failure) }),
  };
}

/**
 * Saves the record of the channels reached so far (`saveProgress`), so a resume killed midway
 * goes on from there. It ends when it began: the resume has not finished.
 */
export function resumeProgress(ctx: ResumeRecordContext, previous: RunRecord): OnDelivered {
  const failure = {
    error: new DigestError(DELIVERY_CUT_OFF, { step: 'deliver' }),
    step: 'deliver' as const,
  };
  return (deliveredTo) => {
    const outcome = { deliveredTo, failure, finishedAt: ctx.startedAt, timings: previous.timings };
    return saveProgress(ctx, resumedRecord(ctx, previous, outcome), previous);
  };
}
