import type { GuardsConfig } from '../config/schema';
import type { OutputGuard } from '../guards/Guard';
import { guardOutputStep } from '../guards/guardOutput';
import { flaggedBy } from '../guards/guardRun';
import type { DraftOutcome } from '../store/runRecord';
import type { GuardCheckId } from '../guards/guardVerdict';
import type { Item } from '../domain/schemas';
import type { ScoredItem } from '../classify/classification';
import type { Logger } from '../shared/telemetry';
import { FALLBACK_WRITER, checkedFallback } from '../write/fallbackDigest';
import type { CheckedDraft } from '../write/write';

export interface FallbackInput {
  readonly selected: readonly ScoredItem[];
  readonly collected: readonly Item[];
  readonly weekId: string;
  readonly topN: number;
  readonly disabledGuards: readonly GuardCheckId[];
  readonly outputGuards: readonly OutputGuard[];
  readonly guardConfig: GuardsConfig['output'];
  /** What happened to the writers' drafts: check and guard ids only, never model text. */
  readonly drafts: readonly DraftOutcome[];
  readonly logger: Logger;
}

export interface Fallback {
  readonly winner: CheckedDraft;
  /** Its output guard verdict, kept in the record: `rejectedBy` names the checks that flagged it. */
  readonly outcome: DraftOutcome;
}

/**
 * The floor under a week whose drafts were all rejected (W11-02): a digest from the selected
 * items' own text, no model call. It must pass the link and format checks; if it does not, that
 * is a bug, and undefined is returned so the week ends blocked as it did before. The output
 * guards run on it once but only advise: the text is input text, so there is nothing for
 * groundedness to check, and a flag is logged and recorded, never blocking.
 */
export async function buildFallback(input: FallbackInput): Promise<Fallback | undefined> {
  const { logger } = input;
  const checked = checkedFallback(input.selected, input);
  if (checked.rejectedBy.length > 0) {
    logger.error('The fallback digest failed its own checks; the week stays blocked', {
      rejectedBy: [...checked.rejectedBy],
    });
    return undefined;
  }
  const guarded = await guardOutputStep([checked.draft], input.selected, {
    guards: input.outputGuards,
    config: input.guardConfig,
    logger,
  });
  const flagged = guarded.rejected.flatMap((entry) => flaggedBy(entry.verdicts));
  logger.warn('No draft survived; sending the fallback', {
    drafts: input.drafts.map((d) => ({ writer: d.writer, rejectedBy: [...d.rejectedBy] })),
    fallbackFlaggedBy: flagged,
  });
  return {
    winner: { draft: checked.draft, markdown: checked.markdown },
    outcome: { writer: FALLBACK_WRITER, passed: flagged.length === 0, rejectedBy: flagged },
  };
}
