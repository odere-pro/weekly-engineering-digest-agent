import { formatDuration, formatRunDuration } from '../../history/history';
import { truncate } from '../../../shared/text';
import type { RunRecord } from '../../../store/runRecord';

const MAX_ERROR_CHARS = 200;

type Counts = RunRecord['counts'];

/**
 * What the input guards kept. A record with `guardedCandidates` ran the model guards after
 * `process`, so `afterGuardInput` counts what the rule guard kept.
 */
function guardedItems(counts: Counts): string {
  const after = counts.guardedCandidates === undefined ? 'after guards' : 'after the rule guard';
  return `${String(counts.afterGuardInput)} ${after}`;
}

function selectedItems(counts: Counts): string {
  const selected = `${String(counts.selected)} selected`;
  return counts.guardedCandidates === undefined
    ? selected
    : `${selected} (model guards checked ${String(counts.guardedCandidates)})`;
}

/** The default `digest show` text: one line per fact of the run, problems last. */
export function summary(record: RunRecord): string {
  const { counts } = record;
  const lines = [
    `Week ${record.runId}: ${record.status}${record.dryRun ? ' (dry run)' : ''}`,
    `Profile:    ${record.profile}`,
    `Started:    ${record.startedAt} (${formatRunDuration(record)})`,
    `Items:      ${String(counts.collected)} collected, ${guardedItems(counts)}, ` +
      `${String(counts.classified)} classified, ${selectedItems(counts)}, ` +
      `${String(counts.digestItems)} in the digest`,
    `Winner:     ${record.winner ?? 'none'}`,
    `Delivered:  ${record.deliveredTo?.join(', ') ?? 'none'}`,
    `Guards off: ${record.disabledGuards.join(', ') || 'none'}`,
    `Timings:    ${record.timings.map((t) => `${t.step} ${formatDuration(t.ms)}`).join(', ') || '-'}`,
    ...record.drafts
      .filter((draft) => !draft.passed)
      .map((draft) => `Rejected:   ${draft.writer} by ${draft.rejectedBy.join(', ') || '-'}`),
    ...record.failedSources.map(
      (s) => `Source failed: ${s.sourceId}: ${truncate(s.error, MAX_ERROR_CHARS)}`,
    ),
    ...(record.error === undefined
      ? []
      : [
          `Error:      ${record.error.message}${record.error.step ? ` (step ${record.error.step})` : ''}`,
        ]),
  ];
  return `${lines.join('\n')}\n`;
}
