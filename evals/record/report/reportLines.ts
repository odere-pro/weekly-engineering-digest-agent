import type { Source } from '../../../src/domain/schemas';
import type { CollectOutput } from '../../../src/sources/collect';
import type { ResolvedSources, WeekRecord } from '../types';
import { weekLine } from './weekLine';

/** The report printed after a run: weeks, sources and failures, one string per line. */
export function reportLines(
  outDir: string,
  records: readonly WeekRecord[],
  resolved: Pick<ResolvedSources, 'sources' | 'origin'>,
  failedSources: CollectOutput['failedSources'],
): string[] {
  const first = records.at(0)?.weekId;
  const last = records.at(-1)?.weekId;
  return [
    `Recorded ${records.length} weeks (${first} to ${last}) in ${outDir}`,
    `Sources: ${resolved.sources.length} (${resolved.origin === 'config' ? 'digest.config.json' : 'default allowlist'})`,
    'Items per week:',
    ...records.map(weekLine),
    'Items per source, all recorded weeks:',
    ...sourceLines(resolved.sources, records),
    ...failedLines(failedSources),
  ];
}

/** Items per source over all weeks: the listed sources first, then any other source recorded. */
export function sourceLines(sources: readonly Source[], records: readonly WeekRecord[]): string[] {
  const counts = new Map<string, number>(sources.map((source) => [source.id, 0]));
  for (const { sourceId } of records.flatMap((record) => record.items)) {
    counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
  }
  const width = Math.max(...[...counts.keys()].map((sourceId) => sourceId.length));
  return [...counts].map(([sourceId, count]) => `  ${sourceId.padEnd(width)}  ${count}`);
}

/** A warning and the way to fix it, or nothing when every source answered. */
export function failedLines(failedSources: CollectOutput['failedSources']): string[] {
  if (failedSources.length === 0) return [];
  const details = failedSources.map(({ sourceId, error }) => `${sourceId} (${error})`);
  return [
    `WARNING: ${failedSources.length} failed sources: ${details.join('; ')}`,
    'Their items are missing, so some weeks are incomplete. Run pnpm eval:record again to fill them in; recorded items are kept.',
  ];
}
