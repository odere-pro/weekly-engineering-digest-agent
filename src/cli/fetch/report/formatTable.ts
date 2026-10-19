import { truncate } from '../../../shared/text';
import { formatDuration } from '../../history/history';
import type { SourceReport } from '../sourceRun/types';

const MAX_TABLE_ERROR_CHARS = 80;
const COLUMN_GAP = '  ';
const TABLE_HEADER = ['Source', 'Status', 'HTTP', 'Items', 'Skipped', 'Time', 'Error'];

/** One row per source, columns padded to their widest cell; a dash stands for "never had one". */
export function formatTable(reports: readonly SourceReport[]): string {
  const rows = [
    TABLE_HEADER,
    ...reports.map((report) => [
      report.source.id,
      report.ok ? 'ok' : 'failed',
      report.httpStatus?.toString() ?? '-',
      report.items.length.toString(),
      report.entries?.skipped.toString() ?? '-',
      formatDuration(report.durationMs),
      truncate(report.error ?? '', MAX_TABLE_ERROR_CHARS),
    ]),
  ];
  const widths = TABLE_HEADER.map((_, col) =>
    Math.max(...rows.map((row) => row[col]?.length ?? 0)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, col) => cell.padEnd(widths[col] ?? 0))
        .join(COLUMN_GAP)
        .trimEnd(),
    )
    .join('\n');
}
