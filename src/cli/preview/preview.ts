import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { knownSecrets } from '../../app/redaction/knownSecrets';
import { renderEmailHtml } from '../../delivery/adapters/email/emailHtml';
import { renderEmailText } from '../../delivery/adapters/email/emailText';
import { toSlackBlocks } from '../../delivery/adapters/slackBlocks/toSlackBlocks';
import { createFsRunStore, type FsRunStoreOptions } from '../../store/adapters/fsRunStore';
import { writeFileAtomic } from '../../store/adapters/atomicFile';
import { weekDigestDir } from '../../store/layout';
import { loadConfig, type LoadedConfig } from '../../config/load';
import { buildDigestView } from '../../render/layout';
import { renderView } from '../../render/markdown';
import { DraftsFileSchema, toJson } from '../../digest/ending/runFiles/runFiles';
import { ExitCode, WEEK_ID_PATTERN } from '../../domain/schemas';
import { createRedactor, type Redactor } from '../../observability/redact';
import type { DigestView } from '../../delivery/Delivery';
import type { RunStore } from '../../store/RunStore';
import { DigestError, errorMessage } from '../../shared/errors';

export interface PreviewCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  week: string;
  channel?: string;
  out?: string;
}

/** Everything the command touches outside itself; tests replace it, `digest preview` uses the defaults. */
export interface PreviewCommandDeps {
  loadConfig: (options: { configPath?: string }) => Promise<LoadedConfig>;
  createFsRunStore: (options: FsRunStoreOptions) => RunStore;
  /** A relative `--out` is resolved against this. */
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultDeps: PreviewCommandDeps = {
  loadConfig: (options) => loadConfig(options),
  createFsRunStore,
  cwd: process.cwd(),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

const CHANNELS = ['markdown', 'email', 'slack', 'all'] as const;
type Channel = (typeof CHANNELS)[number];
/** Escape codes and bidi overrides from feed text; newlines and tabs stay. */
const UNPRINTABLE = /[^\P{Cc}\n\t\r]|\p{Cf}/gu;
const PREVIEW_DIR = 'preview';

/** A file of the preview: its name and the text it holds. */
interface PreviewFile {
  readonly name: string;
  readonly content: string;
}

/** Thrown for a request that cannot be answered; the message is printed as it is. */
class PreviewError extends DigestError {}

/**
 * `digest preview <week>`: renders a saved run's winning draft for each channel into files,
 * without sending anything (W8-07). Returns the process exit code.
 */
export async function previewCommand(
  options: PreviewCommandOptions,
  deps: Partial<PreviewCommandDeps> = {},
): Promise<number> {
  const io: PreviewCommandDeps = { ...defaultDeps, ...deps };
  try {
    const channel = checkRequest(options);
    const loaded = await io.loadConfig({ configPath: options.config });
    const store = io.createFsRunStore({ dataDir: loaded.config.dataDir });
    const redactor = createRedactor(knownSecrets(loaded.secrets));
    const view = await winningView(store, options.week, redactor);
    const files = filesFor(channel, view).map((file) => ({
      ...file,
      content: redactor.text(file.content).replace(UNPRINTABLE, ''),
    }));
    // By default next to the week's run: <dataDir>/<monday>/digest/preview (`store/layout`).
    const dir =
      options.out === undefined
        ? resolve(io.cwd, weekDigestDir(loaded.config.dataDir, options.week), PREVIEW_DIR)
        : resolve(io.cwd, options.out, options.week);
    await mkdir(dir, { recursive: true });
    for (const file of files) await writeFileAtomic(join(dir, file.name), file.content);
    io.stdout(`${files.map((file) => join(dir, file.name)).join('\n')}\n`);
    return ExitCode.Sent;
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n`);
    return error instanceof DigestError ? error.exitCode : ExitCode.Failed;
  }
}

function checkRequest(options: PreviewCommandOptions): Channel {
  if (!WEEK_ID_PATTERN.test(options.week)) {
    throw new PreviewError(`"${options.week}" is not an ISO week id like 2026-W42`);
  }
  if (options.channel === undefined) return 'all';
  const channel = CHANNELS.find((name) => name === options.channel);
  if (channel === undefined) {
    throw new PreviewError(
      `Unknown channel "${options.channel}"; use markdown, email, slack or all`,
    );
  }
  return channel;
}

/** The layout of the run's winning draft, built the way the run builds it. */
async function winningView(store: RunStore, week: string, redactor: Redactor): Promise<DigestView> {
  const record = await store.getRunRecord(week);
  if (record === undefined) throw new PreviewError(`No saved run for ${week}`);
  if (record.winner === null) {
    throw new PreviewError(`Run ${week} (${record.status}) has no winning draft to preview`);
  }
  const raw = await store.readArtifact(week, 'drafts.json');
  if (raw === undefined) throw new PreviewError(`Week ${week} has no drafts.json`);
  const parsed = DraftsFileSchema.safeParse(parseJson(redactor.text(raw)));
  if (!parsed.success) throw new PreviewError('drafts.json does not have the expected shape');
  const winner = parsed.data.drafts.find((draft) => draft.writer === record.winner);
  if (winner === undefined) {
    throw new PreviewError(`drafts.json has no draft by the winner ${record.winner}`);
  }
  return buildDigestView(winner.digest, {
    disabledGuards: record.disabledGuards,
    fallback: record.fallback,
  });
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new PreviewError(`drafts.json is not valid JSON: ${errorMessage(error)}`);
  }
}

function filesFor(channel: Channel, view: DigestView): PreviewFile[] {
  const wants = (name: Channel): boolean => channel === 'all' || channel === name;
  return [
    ...(wants('markdown') ? [{ name: 'digest.md', content: renderView(view) }] : []),
    ...(wants('email')
      ? [
          { name: 'email.html', content: renderEmailHtml(view) },
          { name: 'email.txt', content: renderEmailText(view) },
        ]
      : []),
    ...(wants('slack') ? [{ name: 'slack.json', content: toJson(toSlackBlocks(view)) }] : []),
  ];
}
