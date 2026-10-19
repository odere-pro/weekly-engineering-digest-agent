import type { Logger } from '../../shared/telemetry';
import { boundProblems } from '../writePrompt';
import type { CodeChecked, Rejection } from './types';

/** Logs, at warn, each draft the checks rejected, and returns them for drafts.json. */
export function noteRejections(
  logger: Logger,
  checked: readonly CodeChecked[],
  attempt: Rejection['attempt'],
): Rejection[] {
  const rejections = checked
    .filter((entry) => entry.rejectedBy.length > 0)
    .map(({ draft, rejectedBy, problems }): Rejection => ({
      writer: draft.writer,
      attempt,
      rejectedBy,
      problems: boundProblems(problems),
    }));
  for (const rejection of rejections) logger.warn('Draft failed the checks', { ...rejection });
  return rejections;
}
