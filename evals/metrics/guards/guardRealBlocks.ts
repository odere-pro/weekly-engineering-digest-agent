import { GuardsConfigSchema } from '../../../src/config/schema';
import { GuardCheckIdSchema, type GuardCheckId } from '../../../src/guards/guardVerdict';
import type { RunStatus } from '../../../src/domain/schemas';
import type { DraftOutcome } from '../../../src/store/runRecord';
import { truncate } from '../../../src/shared/text';
import type { WeekDetail } from '../../schema';
import {
  measured,
  withByWeek,
  type CheckedWeek,
  type Measurement,
} from '../measurement/measurement';
import { MAX_PROBLEM_CHARS, uniqueLabels } from '../measurement/weekDetail';

/** What one output guard said about a draft; the harness keeps the reason text. */
interface OutputVerdictRecord {
  check: GuardCheckId;
  flagged: boolean;
  reason?: string;
}

/** How one replay of a recorded week ended, as far as the output guards are concerned. */
export interface ReplayEnd {
  /** Names the replay in `byWeek`; a repeat of the same label is numbered. */
  label: string;
  status: RunStatus;
  drafts: readonly DraftOutcome[];
  outputVerdicts: readonly OutputVerdictRecord[];
}

const GUARD_IDS: ReadonlySet<string> = new Set(GuardCheckIdSchema.options);
const OUTPUT_CHECKS = GuardsConfigSchema.parse({}).output.checks;
const OUTPUT_GUARD_IDS: readonly GuardCheckId[] = GuardCheckIdSchema.options.filter(
  (id) => id in OUTPUT_CHECKS,
);

const isRejectedRun = (end: Pick<ReplayEnd, 'status' | 'drafts'>): boolean =>
  end.status === 'blocked' &&
  end.drafts.length > 0 &&
  end.drafts.every((d) => d.rejectedBy.length > 0);

/** Guards that blocked the run: it ended `blocked` and a guard rejected every one of its drafts. */
function guardBlockers(end: ReplayEnd): GuardCheckId[] {
  if (!isRejectedRun(end)) return [];
  const byGuard = end.drafts.map((d) => d.rejectedBy.filter((id) => GUARD_IDS.has(id)));
  if (byGuard.some((ids) => ids.length === 0)) return [];
  return [...new Set(byGuard.flat())] as GuardCheckId[];
}

/**
 * Why a replay has no digest, from its record: `blocked by <guard>` and `rejected by <check>`
 * (the link or format check, or a failed writer), else the run's status.
 */
export function noDigestCause(end: Pick<ReplayEnd, 'status' | 'drafts'>): string {
  const ids = isRejectedRun(end) ? [...new Set(end.drafts.flatMap((d) => d.rejectedBy))] : [];
  const guards = ids.filter((id) => GUARD_IDS.has(id));
  const checks = ids.filter((id) => !GUARD_IDS.has(id));
  const parts = [
    ...(guards.length > 0 ? [`blocked by ${guards.join(', ')}`] : []),
    ...(checks.length > 0 ? [`rejected by ${checks.join(', ')}`] : []),
  ];
  return parts.length > 0 ? parts.join('; ') : `run ended as "${end.status}"`;
}

function blockMessage(end: ReplayEnd, guards: readonly GuardCheckId[]): string {
  const reasonOf = (guard: GuardCheckId): string | undefined =>
    end.outputVerdicts.find((v) => v.check === guard && v.flagged && v.reason)?.reason;
  const parts = guards.map((guard) => {
    const reason = reasonOf(guard);
    return reason === undefined ? `blocked by ${guard}` : `blocked by ${guard}: ${reason}`;
  });
  return truncate(parts.join('; '), MAX_PROBLEM_CHARS);
}

function replayDetail(end: ReplayEnd, guards: readonly GuardCheckId[]): WeekDetail {
  return guards.length === 0
    ? { status: 'ok', problems: [], problemCount: 0 }
    : { status: 'failed', problems: [blockMessage(end, guards)], problemCount: 1 };
}

/**
 * Share of replays of the recorded weeks, the stability runs included, where an output guard
 * rejected every draft, so the week got no digest. Guard false blocks only sees the synthetic
 * controls; this is the same question on the real drafts. Detail: the replays, the blocked ones,
 * and per output guard the share of replays it took part in blocking. `byWeek` names the guard
 * and the reason for each blocked replay. A run a check (link, format) rejected is not a guard block.
 */
export function guardRealBlocks(ends: readonly ReplayEnd[]): Measurement {
  if (ends.length === 0) return measured(null);
  const labels = uniqueLabels(ends.map((end) => end.label));
  const blockers = ends.map(guardBlockers);
  const blocked = blockers.filter((guards) => guards.length > 0).length;
  const perGuard = OUTPUT_GUARD_IDS.map(
    (id) => [id, blockers.filter((guards) => guards.includes(id)).length / ends.length] as const,
  );
  const checked = ends.map((end, i): CheckedWeek => ({
    label: labels[i] ?? end.label,
    detail: replayDetail(end, blockers[i] ?? []),
  }));
  return {
    ...withByWeek(blocked / ends.length, checked),
    detail: { runs: ends.length, blockedRuns: blocked, ...Object.fromEntries(perGuard) },
  };
}
