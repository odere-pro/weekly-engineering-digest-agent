import { isAppleSilicon } from '../../../config/profiles';
import type { ModelHealth } from '../../../models/ModelProvider';
import { formatGiB, QUALITY_TIGHT_RAM } from './memory';
import type { ProfileRow } from './rows';
import type { ReadinessIo, Target } from './target';

const HEADER = ['profile', 'RAM fits', 'Apple silicon', 'Ollama version', 'models', 'verdict'];

export interface RenderInput {
  target: Target;
  health: ModelHealth;
  rows: readonly ProfileRow[];
  io: Pick<ReadinessIo, 'totalMemoryBytes' | 'nodeVersion'>;
  modelsDir: string | undefined;
  disk: { data: number | undefined; models: number | undefined };
}

/** The whole readiness report: an optional config note, the machine, the table, the notes, the pull lists. */
export function render({ target, health, rows, io, modelsDir, disk }: RenderInput): string {
  const lines = [
    ...(target.configNote ? [`! ${target.configNote}`, ''] : []),
    'Machine',
    ...machineLines({ target, health, io, modelsDir, disk }),
    '',
    'Profiles',
    ...tableLines(rows),
    ...tightLines(rows, io.totalMemoryBytes),
    ...pullLines(rows, health),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function machineLines({
  target,
  health,
  io,
  modelsDir,
  disk,
}: Omit<RenderInput, 'rows'>): string[] {
  const { platform } = target;
  const free = (bytes: number | undefined): string =>
    bytes === undefined ? 'unknown' : formatGiB(bytes);
  const ollama = health.reachable
    ? `${health.version ?? 'unknown version'} at ${target.ollamaUrl}`
    : `not reachable at ${target.ollamaUrl}${health.error ? ` (${health.error})` : ''}`;
  return field([
    ['OS', `${platform.os} (${platform.arch})`],
    ['Apple silicon', isAppleSilicon(platform) ? 'yes' : 'no'],
    ['RAM (seen by this process)', formatGiB(io.totalMemoryBytes)],
    [`Free disk, data dir (${target.dataDir})`, free(disk.data)],
    ...(modelsDir === undefined
      ? []
      : [[`Free disk, Ollama models (${modelsDir})`, free(disk.models)] as const]),
    ['Node', io.nodeVersion],
    ['Ollama', ollama],
    ...(health.reachable && health.error ? [['Ollama models', health.error] as const] : []),
  ]);
}

function field(pairs: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...pairs.map(([label]) => label.length));
  return pairs.map(([label, value]) => `  ${`${label}:`.padEnd(width + 2)}${value}`);
}

export function tableLines(rows: readonly ProfileRow[]): string[] {
  const cells = rows.map((row) => [
    row.name,
    ramCell(row),
    row.needsAppleSilicon
      ? row.hasAppleSilicon
        ? 'needed, present'
        : 'needed, missing'
      : 'not needed',
    versionCell(row),
    row.installed === undefined
      ? `unknown of ${String(row.total)}`
      : `${String(row.installed)} of ${String(row.total)} installed`,
    row.verdict,
  ]);
  const widths = HEADER.map((title, i) =>
    Math.max(title.length, ...cells.map((r) => r[i]?.length ?? 0)),
  );
  const format = (row: readonly string[]): string =>
    `  ${row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ')}`.trimEnd();
  return [format(HEADER), ...cells.map(format)];
}

function ramCell(row: ProfileRow): string {
  if (row.ram === 'maybe') return 'yes (not measured)';
  return row.ram;
}

/** Why a row is `tight`: the measured numbers `digest init` quotes for the same RAM. Empty when none is. */
export function tightLines(rows: readonly ProfileRow[], totalMemoryBytes: number): string[] {
  return rows
    .filter((row) => row.ram === 'tight')
    .flatMap((row) => [
      '',
      `${row.name} is tight on ${formatGiB(totalMemoryBytes)} of RAM: ${QUALITY_TIGHT_RAM}.`,
    ]);
}

function versionCell(row: ProfileRow): string {
  const minimum = row.profile.minOllamaVersion;
  if (row.version === 'ok') return `ok (min ${minimum})`;
  if (row.version === 'too old') return `too old (min ${minimum})`;
  return `unknown (min ${minimum})`;
}

/** For each row that needs pulls: what to update or start, then one `ollama pull` per missing tag. */
export function pullLines(rows: readonly ProfileRow[], health: ModelHealth): string[] {
  return rows
    .filter((row) => row.verdict === 'pull models')
    .flatMap((row) => [
      '',
      `To get ${row.name} ready:`,
      ...(row.version === 'too old'
        ? [`  update Ollama to ${row.profile.minOllamaVersion} or later`]
        : []),
      ...(health.reachable ? [] : ['  start Ollama ("ollama serve"), then re-run this check']),
      ...row.missing.map((tag) => `  ollama pull ${tag}`),
    ]);
}
