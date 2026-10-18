import { z } from 'zod';
import { knownSecrets } from '../../app/redacting';
import { createFsRunStore, type FsRunStoreOptions } from '../../store/adapters/fsRunStore';
import { loadConfig, type LoadedConfig } from '../../config/load';
import { DraftsFileSchema, toJson } from '../../digest/runEnding';
import {
  ClassificationSchema,
  ExitCode,
  ItemSchema,
  WEEK_ID_PATTERN,
  type Classification,
  type Item,
  type RunRecord,
} from '../../domain/schemas';
import { createRedactor } from '../../observability/redact';
import type { ArtifactName, RunStore } from '../../store/RunStore';
import { DigestError, errorMessage } from '../../shared/errors';
import { truncate } from '../../shared/text';
import { formatDuration, formatRunDuration } from '../history/history';

export interface ShowCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  week: string;
  part?: string;
  json?: boolean;
}

/** Everything the command touches outside itself; tests replace it, `digest show` uses the defaults. */
export interface ShowCommandDeps {
  loadConfig: (options: { configPath?: string }) => Promise<LoadedConfig>;
  createFsRunStore: (options: FsRunStoreOptions) => RunStore;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultDeps: ShowCommandDeps = {
  loadConfig: (options) => loadConfig(options),
  createFsRunStore,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

const PARTS = ['items', 'scores', 'drafts', 'digest', 'run', 'review'] as const;
type Part = (typeof PARTS)[number];

const ARTIFACT_OF: Readonly<Record<Exclude<Part, 'run'>, ArtifactName>> = {
  items: 'items.json',
  scores: 'scores.json',
  drafts: 'drafts.json',
  digest: 'digest.md',
  review: 'review.md',
};

const COLUMN_GAP = '  ';
const MAX_CELL_CHARS = 70;
const MAX_PROBLEM_CHARS = 200;
const SCORE_DECIMALS = 1;
const PERCENT = 100;
/** Control and format characters (escape codes, bidi overrides) have no place in a terminal. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu;
const UNPRINTABLE_IN_TEXT = /[^\P{Cc}\n\t\r]|\p{Cf}/gu;

/** Thrown for a request that cannot be answered; the message is printed as it is. */
class ShowError extends DigestError {}

const OutcomeNotesSchema = z.object({
  failures: z
    .array(z.object({ writer: z.string(), error: z.string().optional() }))
    .optional()
    .catch(undefined),
  rejections: z
    .array(
      z.object({
        writer: z.string(),
        attempt: z.number().optional(),
        rejectedBy: z.array(z.string()),
        problems: z.array(z.string()),
      }),
    )
    .optional()
    .catch(undefined),
});

/** `digest show <week>`: prints a saved run's summary or one part of it (W8-07). Returns the exit code. */
export async function showCommand(
  options: ShowCommandOptions,
  deps: Partial<ShowCommandDeps> = {},
): Promise<number> {
  const io: ShowCommandDeps = { ...defaultDeps, ...deps };
  try {
    const part = checkRequest(options);
    const loaded = await io.loadConfig({ configPath: options.config });
    const store = io.createFsRunStore({ dataDir: loaded.config.dataDir });
    const redactor = createRedactor(knownSecrets(loaded.secrets));
    const text = await render(store, options, part);
    io.stdout(redactor.text(clean(text)));
    return ExitCode.Sent;
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`);
    return error instanceof DigestError ? error.exitCode : ExitCode.Failed;
  }
}

function checkRequest(options: ShowCommandOptions): Part | undefined {
  if (!WEEK_ID_PATTERN.test(options.week)) {
    throw new ShowError(`"${options.week}" is not an ISO week id like 2026-W42`);
  }
  if (options.part === undefined) return undefined;
  const part = PARTS.find((name) => name === options.part);
  if (part === undefined) {
    throw new ShowError(`Unknown part "${options.part}"; use ${PARTS.join(', ')}`);
  }
  return part;
}

function clean(text: string): string {
  return text.replace(UNPRINTABLE_IN_TEXT, '');
}

const withNewline = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`);

async function render(
  store: RunStore,
  options: ShowCommandOptions,
  part: Part | undefined,
): Promise<string> {
  const week = options.week;
  const record = await store.getRunRecord(week);
  if (part === undefined || part === 'run') {
    if (record === undefined) throw noRun(week);
    return options.json === true || part === 'run' ? toJson(record) : summary(record);
  }
  const name = ARTIFACT_OF[part];
  const raw = await store.readArtifact(week, name);
  if (raw === undefined) throw record === undefined ? noRun(week) : noFile(week, name, record);
  if (options.json === true) return raw;
  if (part === 'digest' || part === 'review') return withNewline(raw);
  return tableOf(part, week, raw, store);
}

const noRun = (week: string): ShowError => new ShowError(`No saved run for ${week}`);

const noFile = (week: string, name: string, record: RunRecord): ShowError =>
  new ShowError(`Week ${week} has no ${name} (run status: ${record.status})`);

function parseFile<T>(name: string, raw: string, schema: z.ZodType<T>): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ShowError(`${name} is not valid JSON: ${errorMessage(error)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ShowError(`${name} does not have the expected shape`);
  return parsed.data;
}

async function tableOf(
  part: 'items' | 'scores' | 'drafts',
  week: string,
  raw: string,
  store: RunStore,
): Promise<string> {
  if (part === 'items') return itemsTable(parseFile('items.json', raw, z.array(ItemSchema)));
  if (part === 'scores') return scoresTable(week, raw, store);
  return draftsTable(week, raw, store);
}

// ---------------------------------------------------------------------------------------------
// Tables

function cell(text: string): string {
  return truncate(text.replace(UNPRINTABLE, ' '), MAX_CELL_CHARS);
}

function table(rows: readonly (readonly string[])[]): string {
  const [header = []] = rows;
  const widths = header.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? '').length)));
  return `${rows
    .map((row) =>
      row
        .map((text, col) => text.padEnd(widths[col] ?? 0))
        .join(COLUMN_GAP)
        .trimEnd(),
    )
    .join('\n')}\n`;
}

function itemsTable(items: readonly Item[]): string {
  if (items.length === 0) return 'No items were collected.\n';
  const header = ['Source', 'Title', 'Published', 'URL'];
  return table([
    header,
    ...items.map((item) => [
      cell(item.sourceId),
      cell(item.title),
      item.publishedAt.slice(0, 'YYYY-MM-DD'.length),
      item.url,
    ]),
  ]);
}

async function scoresTable(week: string, raw: string, store: RunStore): Promise<string> {
  const scores = parseFile('scores.json', raw, z.array(ClassificationSchema));
  const itemsRaw = await store.readArtifact(week, 'items.json');
  const items =
    itemsRaw === undefined ? [] : parseFile('items.json', itemsRaw, z.array(ItemSchema));
  const inDigest = await digestItemIds(week, store);
  const titles = new Map(items.map((item) => [item.id, item.title]));
  const scored = new Set(scores.map((score) => score.itemId));
  const header = ['Item', 'Relevance', 'Area', 'Hype', 'Minor', 'Status'];
  const rows = scores.map((score) => [
    cell(titles.get(score.itemId) ?? score.itemId),
    score.relevance.toFixed(SCORE_DECIMALS),
    cell(`${score.area} (${percent(score.areaConfidence)})`),
    percent(score.hype),
    percent(score.minorRelease),
    statusOf(score, inDigest),
  ]);
  const dropped = items
    .filter((item) => !scored.has(item.id))
    .map((item) => [cell(item.title), '-', '-', '-', '-', 'dropped before scoring (input guard)']);
  return table([header, ...rows, ...dropped]);
}

const percent = (probability: number): string => `${Math.round(probability * PERCENT)}%`;

function statusOf(score: Classification, inDigest: ReadonlySet<string>): string {
  return inDigest.has(score.itemId) ? 'in digest' : 'scored, not picked';
}

/** The item ids of the winning draft; empty when the week has no readable drafts. */
async function digestItemIds(week: string, store: RunStore): Promise<Set<string>> {
  const [record, raw] = await Promise.all([
    store.getRunRecord(week),
    store.readArtifact(week, 'drafts.json'),
  ]);
  if (raw === undefined || record?.winner == null) return new Set();
  const drafts = parseFile('drafts.json', raw, DraftsFileSchema).drafts;
  const winner = drafts.find((draft) => draft.writer === record.winner);
  return new Set(winner?.digest.items.map((item) => item.itemId));
}

function draftsTable(week: string, raw: string, store: RunStore): Promise<string> {
  return store.getRunRecord(week).then((record) => {
    const file = parseFile('drafts.json', raw, DraftsFileSchema);
    const notes = parseFile('drafts.json', raw, OutcomeNotesSchema);
    const header = ['Writer', 'Passed', 'Rejected by', 'Items', 'Judge'];
    const outcomes = record?.drafts ?? [];
    const known = new Set(outcomes.map((outcome) => outcome.writer));
    const rows = [
      ...outcomes.map((outcome) => [
        cell(outcome.writer),
        outcome.passed ? 'yes' : 'no',
        cell(outcome.rejectedBy.join(', ') || '-'),
        itemCount(file, outcome.writer),
        outcome.score === undefined ? '-' : outcome.score.score.toFixed(SCORE_DECIMALS),
      ]),
      ...file.drafts
        .filter((draft) => !known.has(draft.writer))
        .map((draft) => [cell(draft.writer), '-', '-', itemCount(file, draft.writer), '-']),
    ];
    return `${table([header, ...rows])}${problemLines(notes)}`;
  });
}

const itemCount = (file: z.infer<typeof DraftsFileSchema>, writer: string): string =>
  String(file.drafts.find((draft) => draft.writer === writer)?.digest.items.length ?? 0);

function problemLines(notes: z.infer<typeof OutcomeNotesSchema>): string {
  const lines = [
    ...(notes.rejections ?? []).flatMap((rejection) =>
      rejection.problems.map(
        (problem) => `  ${rejection.writer}: ${truncate(problem, MAX_PROBLEM_CHARS)}`,
      ),
    ),
    ...(notes.failures ?? []).map(
      (failure) => `  ${failure.writer}: ${truncate(failure.error ?? 'failed', MAX_PROBLEM_CHARS)}`,
    ),
  ];
  return lines.length === 0 ? '' : `\nProblems:\n${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Summary

function summary(record: RunRecord): string {
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
      (s) => `Source failed: ${s.sourceId}: ${truncate(s.error, MAX_PROBLEM_CHARS)}`,
    ),
    ...(record.error === undefined
      ? []
      : [
          `Error:      ${record.error.message}${record.error.step ? ` (step ${record.error.step})` : ''}`,
        ]),
  ];
  return `${lines.join('\n')}\n`;
}
