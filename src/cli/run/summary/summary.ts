import { join } from 'node:path';
import type { LoadedConfig } from '../../../config/load';
import type { RunResult } from '../../../digest/types';
import { DIGEST_FILE } from '../../../store/adapters/runFolders';
import { weekDigestDir } from '../../../store/layout';
import { formatRunDuration } from '../../history/history';
import type { LocalFiles } from './localFiles';

export const LABEL_WIDTH = 'Duration'.length;

/** The command's output channels; everything printed passes through the secret redaction. */
export interface Reporter {
  out: (text: string) => void;
  err: (text: string) => void;
}

export function printSummary(
  report: Reporter,
  loaded: LoadedConfig,
  result: RunResult,
  files: LocalFiles | undefined,
): void {
  const { record } = result;
  const fields: [string, string][] = [
    ['Week', record.runId],
    ['Status', record.status],
    ['Items', `${record.counts.collected} collected → ${record.counts.digestItems} in digest`],
    ['Winner', record.winner ?? '-'],
    ['Duration', formatRunDuration(record)],
  ];
  if (result.markdown !== undefined) {
    fields.push(['Digest', join(weekDigestDir(loaded.config.dataDir, record.runId), DIGEST_FILE)]);
  }
  if (files) {
    fields.push(['Markdown', files.markdown]);
    if (files.html !== undefined) fields.push(['HTML', files.html]);
  }
  const lines = fields.map(([label, value]) => `${label.padEnd(LABEL_WIDTH)}  ${value}`);
  for (const source of record.failedSources) {
    lines.push(`Failed source: ${source.sourceId} (${source.error})`);
  }
  for (const draft of record.drafts) {
    if (!draft.passed)
      lines.push(`Rejected draft: ${draft.writer} (${draft.rejectedBy.join(', ')})`);
  }
  const note = statusNote(record.status);
  if (note) lines.push(note);
  if (result.kept !== undefined) lines.push(keptNote(result.kept));
  report.out(`${lines.join('\n')}\n`);
  if (record.error) {
    const step = record.error.step ? ` (step: ${record.error.step})` : '';
    report.err(`Error${step}: ${record.error.message}\n`);
  }
}

/** The reason is in the log too; here it stands in for the Digest line a kept week does not get. */
export function keptNote(reason: string): string {
  return `${reason}. The week's run folder is unchanged.`;
}

export function statusNote(status: RunResult['record']['status']): string | undefined {
  switch (status) {
    case 'dry-run':
      return 'Dry run: nothing was sent.';
    case 'skipped':
      return 'This week already has a sent digest. Use --force to run it again.';
    default:
      return undefined;
  }
}
