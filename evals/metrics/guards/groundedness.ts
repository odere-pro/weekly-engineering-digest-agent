import type { GuardCheckId } from '../../../src/guards/guardVerdict';
import { measured, type Measurement } from '../measurement/measurement';
import { countBy, share } from '../measurement/numbers';

export interface GroundingOutcome {
  caseId: string;
  caught: boolean;
  /** Output guards that flagged the draft with the planted claim. */
  flaggedBy: readonly GuardCheckId[];
}

/** Share of planted unsupported claims the output guards caught; detail counts each guard. */
export function groundedness(outcomes: readonly GroundingOutcome[]): Measurement {
  const caught = outcomes.filter((o) => o.caught).length;
  return measured(share(caught, outcomes.length), countBy(outcomes.flatMap((o) => o.flaggedBy)));
}
