import { formatDuration, formatRunDuration } from '../../history/history';
import { truncate } from '../../../shared/text';
import type { RunRecord } from '../../../store/runRecord';

const MAX_ERROR_CHARS = 200;

/** The default `digest show` text: one line per fact of the run, problems last. */
export function summary(record: RunRecord): string {
  const { counts } = record;
  const lines = [
    `Week ${record.runId}: ${record.status}${record.dryRun ? ' (dry run)' : ''}`,
    `Profile:    ${record.profile}`,
    `Started:    ${record.startedAt} (${formatRunDuration(record)})`,
    `Items:      ${String(counts.collected)} collected, ${String(counts.afterGuardInput)} after guards, ` +
      `${String(counts.classified)} classified, ${String(counts.selected)} selected, ` +
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
