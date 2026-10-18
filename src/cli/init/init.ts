import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { checkbox, confirm, input, password, select } from '@inquirer/prompts';
import { z } from 'zod';
import { DEFAULT_FOCUS_AREAS, DEFAULT_SOURCES } from '../../sources/defaultSources';
import {
  formatEnvValue,
  mergeEnvText,
  resolveHostPlatform,
  type EnvUpdate,
} from '../../config/load';
import {
  ConfigSchema,
  EmailDeliverySchema,
  ProfileNameSchema,
  SecretsSchema,
  type ConfigInput,
  type ProfileName,
} from '../../config/schema';
import { ExitCode } from '../../domain/schemas';
import {
  renderOsSchedule,
  type OsSchedule,
  type OsScheduleOptions,
} from '../../scheduler/osSchedule';
import { formatGiB, hasQualityMemory } from '../doctor/readiness';
import { DigestError, errorMessage, NotImplementedError } from '../../shared/errors';

export interface InitCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Accept defaults without prompting. */
  yes?: boolean;
}

/** Returns true when the answer is acceptable, otherwise the message to show. */
export type Validate = (value: string) => true | string;

export interface InitPrompts {
  confirm(options: { message: string; default: boolean }): Promise<boolean>;
  checkbox(options: {
    message: string;
    choices: readonly { name: string; value: string; checked?: boolean }[];
  }): Promise<string[]>;
  input(options: { message: string; default?: string; validate?: Validate }): Promise<string>;
  select<T extends string>(options: {
    message: string;
    choices: readonly { name: string; value: T; description?: string }[];
    default: T;
  }): Promise<T>;
  password(options: { message: string; validate?: Validate }): Promise<string>;
}

/** Everything the command touches outside itself; tests replace it, `digest init` uses the defaults. */
export interface InitIo {
  prompts: InitPrompts;
  /** Process environment; only DIGEST_HOST_OS is read. */
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  totalMemoryBytes: number;
  /** What a container is limited to (cgroup), in bytes; 0 or unset when there is no limit. */
  memoryLimitBytes?: number;
  /** The IANA zone this process runs in; the default for `schedule.timeZone`. */
  timeZone: string;
  cwd: string;
  /** Where the secrets file goes; digest loads ./.env. */
  envPath: string;
  /** How a scheduler starts digest, without arguments, e.g. "/usr/local/bin/digest". */
  scheduleProgram: string;
  renderSchedule: (os: NodeJS.Platform, options: OsScheduleOptions) => OsSchedule;
  exists: (path: string) => Promise<boolean>;
  /** True for an existing file with no content, such as the ones `make docker-init` creates. */
  isEmptyFile: (path: string) => Promise<boolean>;
  /** The text of a file, undefined when it does not exist. Other failures reject. */
  readFile: (path: string) => Promise<string | undefined>;
  /** Writes a normal file, creating its folder. */
  writeFile: (path: string, content: string) => Promise<void>;
  /**
   * Writes a file that only its owner can read (mode 0600), replacing any existing file. Goes
   * through a temp file and a rename; where that is impossible (a single-file bind mount in
   * Docker, a read-only folder) it writes the existing file in place.
   */
  writeSecretFile: (path: string, content: string) => Promise<void>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_CONFIG_PATH = 'digest.config.json';
const DEFAULT_ENV_PATH = '.env';
const DOCKERENV_PATH = '/.dockerenv';
const SECRET_FILE_MODE = 0o600;
const DEFAULT_SMTP_PORT = 587;
const IMPLICIT_TLS_PORT = 465;
const OLLAMA_PORT = 11434;
const GROUP_AND_OTHER_BITS = 0o077;
const OWNER_ONLY_HINT =
  'Run "chmod 600" on it on the host, or set DIGEST_UID and DIGEST_GID to your user (see docker-compose.yml).';
/** A rename onto these fails when the target is a bind mount or its folder is not writable. */
const IN_PLACE_FALLBACK_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EXDEV', 'EACCES', 'EPERM']);
/** What a container reports when TZ is not set. */
const CONTAINER_DEFAULT_ZONES: ReadonlySet<string> = new Set(['UTC', 'Etc/UTC']);

/** `light` is the 16 GB profile only where the tuned models run (a Mac with Apple silicon). */
const LIGHT_OFF_MAC =
  'Off a Mac with Apple silicon it uses the larger fallback models, which need much more than 16 GB; "digest doctor" shows what this machine gets.';

const QUALITY_UNMEASURED =
  'quality is not measured yet: one run took about 1 h on the reference laptop';

const PROFILE_DESCRIPTIONS: Readonly<Record<ProfileName, string>> = {
  quality: `Two writers and a judge. Best output expected, but ${QUALITY_UNMEASURED}. About 32 GB RAM and 40 GB of disk.`,
  fast: 'One writer, no judge. Faster runs.',
  light: 'Smallest models. Fits in 16 GB of RAM.',
};

const FocusAreasSchema = ConfigSchema.shape.focusAreas;
const HttpsUrlSchema = z.url({ protocol: /^https$/ });

/**
 * `light` until `quality` has a measured baseline, whatever the RAM. The schema default stays
 * `quality`; this only decides what `digest init` suggests and writes with --yes.
 */
export function recommendProfile(): ProfileName {
  return 'light';
}

// The RAM figures live in readiness.ts so `digest doctor --readiness` and init cannot drift.
export { hasQualityMemory };

/**
 * Where Ollama is reachable from here. Inside Docker on a Mac the Apple GPU is only available to
 * the Ollama app on the host; inside Docker elsewhere the compose `ollama` service is used.
 */
export function resolveOllamaUrl(mode: { inDocker: boolean; hostOs: string | undefined }): string {
  if (!mode.inDocker) return `http://localhost:${String(OLLAMA_PORT)}`;
  const host = mode.hostOs === 'darwin' ? 'host.docker.internal' : 'ollama';
  return `http://${host}:${String(OLLAMA_PORT)}`;
}

/** `digest init`: Asks for focus areas, delivery and profile, then writes digest.config.json and .env (W1-18). Returns the process exit code. */
export async function initCommand(
  options: InitCommandOptions,
  overrides: Partial<InitIo> = {},
): Promise<number> {
  const io: InitIo = { ...createDefaultIo(), ...overrides };
  try {
    return await runInit(options, io);
  } catch (error) {
    if (isPromptCancelled(error)) {
      io.stderr('Cancelled. Nothing was written.\n');
      return ExitCode.Failed;
    }
    if (!(error instanceof DigestError)) throw error;
    io.stderr(`${error.message}\n`);
    return error.exitCode;
  }
}

interface EmailAnswers {
  delivery: NonNullable<ConfigInput['delivery']>['email'];
  password: string;
}

interface Answers {
  profile: ProfileName;
  timeZone: string;
  focusAreas: string[];
  email?: EmailAnswers;
  slackWebhook?: string;
}

async function runInit(options: InitCommandOptions, io: InitIo): Promise<number> {
  const configPath = options.config ?? DEFAULT_CONFIG_PATH;
  // Only the config is replaced; .env is merged into, so it needs no confirmation.
  await confirmOverwrite([configPath], options.yes === true, io);

  const inDocker = await io.exists(DOCKERENV_PATH);
  const hostOs = namedHostOs(io, inDocker);
  const host: Host = { inDocker, hostOs };
  const answers = options.yes === true ? defaultAnswers(io) : await askAnswers(io, host);
  const config = validatedConfig(buildConfigInput(answers));
  const ollamaUrl = resolveOllamaUrl({ inDocker, hostOs });
  const envFile = await buildEnvFile(io, ollamaUrl, secretsOf(answers));

  await writeOrFail(configPath, () => io.writeFile(configPath, toJson(buildConfigInput(answers))));
  await writeOrFail(io.envPath, () => io.writeSecretFile(io.envPath, envFile.text));

  io.stdout(
    summary({ configPath, envPath: io.envPath, answers, ollamaUrl, envMerged: envFile.merged }),
  );
  io.stdout(
    inDocker
      ? dockerNextSteps(answers.timeZone)
      : scheduleSection(io, configPath, config.schedule.cron),
  );
  return ExitCode.Sent;
}

// ---------------------------------------------------------------- existing files

/** An empty file is as good as none: Docker needs the files to exist before the first run. */
async function confirmOverwrite(paths: string[], yes: boolean, io: InitIo): Promise<void> {
  const present = await Promise.all(
    paths.map(async (path) => ((await hasContent(path, io)) ? path : '')),
  );
  const existing = present.filter((path) => path !== '');
  if (existing.length === 0) return;

  const list = existing.join(' and ');
  if (yes) {
    throw new DigestError(
      `Refusing to overwrite ${list} with --yes. Move it away, or run "digest init" without --yes to confirm.`,
    );
  }
  const overwrite = await io.prompts.confirm({ message: `Overwrite ${list}?`, default: false });
  if (!overwrite) throw new DigestError(`Kept ${list}. Nothing was written.`);
}

async function hasContent(path: string, io: InitIo): Promise<boolean> {
  return (await io.exists(path)) && !(await io.isEmptyFile(path));
}

// ---------------------------------------------------------------- questions

function defaultAnswers(io: InitIo): Answers {
  return {
    profile: recommendProfile(),
    timeZone: io.timeZone,
    focusAreas: [...DEFAULT_FOCUS_AREAS],
  };
}

/** Where init runs and, in a container, the OS of the machine that runs Ollama. */
interface Host {
  inDocker: boolean;
  hostOs: string | undefined;
}

async function askAnswers(io: InitIo, host: Host): Promise<Answers> {
  const { prompts } = io;
  const focusAreas = await askFocusAreas(prompts);
  const profile = await askProfile(io, host);
  const timeZone = await askTimeZone(io, host.inDocker);
  const channels = await prompts.checkbox({
    message: 'Also deliver the digest by (Markdown files are always written)',
    choices: [
      { name: 'Email (SMTP)', value: 'email' },
      { name: 'Slack (incoming webhook)', value: 'slack' },
    ],
  });
  const email = channels.includes('email') ? await askEmail(prompts) : undefined;
  const slackWebhook = channels.includes('slack') ? await askSlackWebhook(prompts) : undefined;
  return {
    profile,
    timeZone,
    focusAreas,
    ...(email && { email }),
    ...(slackWebhook && { slackWebhook }),
  };
}

async function askFocusAreas(prompts: InitPrompts): Promise<string[]> {
  const picked = await prompts.checkbox({
    message: 'Focus areas (space to toggle, enter to confirm)',
    choices: DEFAULT_FOCUS_AREAS.map((area) => ({ name: area, value: area, checked: true })),
  });
  const typed = await prompts.input({
    message: 'Other focus areas (comma-separated, optional)',
    validate: (value) => focusAreasProblem(mergeFocusAreas(picked, value)) ?? true,
  });
  return mergeFocusAreas(picked, typed);
}

/** Trimmed, non-empty, unique ignoring case; the first spelling wins. */
function mergeFocusAreas(picked: readonly string[], typed: string): string[] {
  const seen = new Set<string>();
  return [...picked, ...splitList(typed)].flatMap((area) => {
    const name = area.trim();
    const key = name.toLowerCase();
    if (name === '' || seen.has(key)) return [];
    seen.add(key);
    return [name];
  });
}

function focusAreasProblem(areas: string[]): string | undefined {
  const result = FocusAreasSchema.safeParse(areas);
  return result.success ? undefined : `Focus areas: ${describeIssues(result.error)}`;
}

async function askProfile(io: InitIo, host: Host): Promise<ProfileName> {
  const recommended = recommendProfile();
  const notes: Partial<Record<ProfileName, string>> = {
    ...((host.hostOs ?? io.platform) === 'darwin' ? {} : { light: LIGHT_OFF_MAC }),
    ...qualityNote(io, host.inDocker),
  };
  return io.prompts.select({
    message: 'Model profile',
    default: recommended,
    choices: ProfileNameSchema.options.map((profile) => ({
      name: profile === recommended ? `${profile} (recommended)` : profile,
      value: profile,
      description: [PROFILE_DESCRIPTIONS[profile], notes[profile]].filter(Boolean).join(' '),
    })),
  });
}

function qualityNote(io: InitIo, inDocker: boolean): { quality?: string } {
  const warning = qualityMemoryWarning(io, inDocker);
  return warning === undefined ? {} : { quality: warning };
}

/**
 * Says so when the RAM this process can see is short of what `quality` needs. Inside Docker the
 * figure is the container's, not necessarily the machine's that runs Ollama, and the text names
 * the limit when there is one.
 */
function qualityMemoryWarning(io: InitIo, inDocker: boolean): string | undefined {
  const limit = io.memoryLimitBytes ?? 0;
  const limited = limit > 0 && limit <= io.totalMemoryBytes;
  const seen = limited ? limit : io.totalMemoryBytes;
  if (hasQualityMemory(seen)) return undefined;
  const amount = formatGiB(seen);
  const needs = 'quality needs about 32 GB.';
  if (!inDocker) return `This machine has ${amount} of RAM; ${needs}`;
  if (limited) return `Docker limits this container to ${amount} (the container limit); ${needs}`;
  return `Docker shows this container ${amount} of RAM; ${needs} Ollama may run elsewhere with more.`;
}

/**
 * The OS Ollama runs on, spelled as the loader reads it (`Darwin` from `uname -s` is a Mac too).
 * Only a container needs it, so a bad value elsewhere is left for the loader to report.
 */
function namedHostOs(io: InitIo, inDocker: boolean): string | undefined {
  const named = io.env['DIGEST_HOST_OS'];
  if (!inDocker || named === undefined || named.trim() === '') return undefined;
  return resolveHostPlatform({ DIGEST_HOST_OS: named }).os;
}

/** The default is where this process runs; in a container that is UTC unless TZ is set. */
async function askTimeZone(io: InitIo, inDocker: boolean): Promise<string> {
  const containerOnUtc = inDocker && CONTAINER_DEFAULT_ZONES.has(io.timeZone);
  const hint = containerOnUtc
    ? ' (the container runs on UTC unless TZ is set; enter your own zone, e.g. Europe/Berlin)'
    : '';
  const zone = await io.prompts.input({
    message: `Time zone for the weekly schedule${hint}`,
    default: io.timeZone,
    validate: (value) => isTimeZone(value.trim()) || 'Enter an IANA time zone, e.g. Europe/Berlin',
  });
  return zone.trim();
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value !== '';
  } catch {
    return false;
  }
}

async function askEmail(prompts: InitPrompts): Promise<EmailAnswers> {
  const shape = EmailDeliverySchema.shape;
  const host = await prompts.input({
    message: 'SMTP host',
    validate: validateWith(shape.host, 'host name'),
  });
  const port = await prompts.input({
    message: 'SMTP port',
    default: String(DEFAULT_SMTP_PORT),
    validate: (value) => shape.port.safeParse(Number(value)).success || 'Enter a port, 1-65535',
  });
  const secure = await prompts.confirm({
    message: 'Use implicit TLS (TLS from the first byte, usually port 465)?',
    default: Number(port) === IMPLICIT_TLS_PORT,
  });
  const user = await prompts.input({
    message: 'SMTP user',
    validate: validateWith(shape.user, 'user name'),
  });
  const from = await prompts.input({
    message: 'From address',
    ...(isEmail(user) && { default: user.trim() }),
    validate: validateWith(shape.from, 'email address'),
  });
  const to = await prompts.input({
    message: 'Recipients (comma-separated)',
    validate: (value) =>
      shape.to.safeParse(splitList(value)).success || 'Enter one or more email addresses',
  });
  const secret = await prompts.password({
    message: 'SMTP password',
    validate: (value) => value.length > 0 || 'Enter the password',
  });
  return {
    delivery: {
      host: host.trim(),
      port: Number(port),
      secure,
      requireTLS: true,
      user: user.trim(),
      from: from.trim(),
      to: splitList(to),
    },
    password: secret,
  };
}

async function askSlackWebhook(prompts: InitPrompts): Promise<string> {
  const webhook = await prompts.password({
    message: 'Slack webhook URL',
    validate: validateWith(HttpsUrlSchema, 'https URL'),
  });
  return webhook.trim();
}

function validateWith(schema: z.ZodType, what: string): Validate {
  return (value) => schema.safeParse(value.trim()).success || `Enter a valid ${what}`;
}

function isEmail(value: string): boolean {
  return z.email().safeParse(value.trim()).success;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

// ---------------------------------------------------------------- config and .env

function buildConfigInput(answers: Answers): ConfigInput {
  const delivery = {
    ...(answers.email && { email: answers.email.delivery }),
    ...(answers.slackWebhook !== undefined && { slack: { enabled: true } }),
  };
  return {
    profile: answers.profile,
    focusAreas: answers.focusAreas,
    schedule: { timeZone: answers.timeZone },
    sources: [...DEFAULT_SOURCES],
    ...(Object.keys(delivery).length > 0 && { delivery }),
  };
}

function validatedConfig(input: ConfigInput): z.output<typeof ConfigSchema> {
  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    throw new DigestError(
      `Those answers do not make a valid config, nothing was written.\n${describeIssues(result.error)}`,
    );
  }
  return result.data;
}

function secretsOf(answers: Answers): Record<string, string> {
  const secrets = {
    ...(answers.email && { SMTP_PASSWORD: answers.email.password }),
    ...(answers.slackWebhook !== undefined && { SLACK_WEBHOOK_URL: answers.slackWebhook }),
  };
  const parsed = SecretsSchema.safeParse(secrets);
  if (!parsed.success) {
    // Names the keys only: the values are secrets.
    const keys = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new DigestError(`Invalid secret value for ${keys}, nothing was written.`);
  }
  return secrets;
}

function renderEnvFile(ollamaUrl: string, secrets: Record<string, string>): string {
  const lines = [
    '# Written by "digest init". Keep this file private and out of git.',
    `OLLAMA_URL=${formatEnvValue('OLLAMA_URL', ollamaUrl)}`,
    ...Object.entries(secrets).map(([key, value]) => `${key}=${formatEnvValue(key, value)}`),
    '# Optional: a GitHub token raises the API rate limit for release feeds.',
    '# GITHUB_TOKEN=',
  ];
  return `${lines.join('\n')}\n`;
}

interface EnvFile {
  text: string;
  /** True when init's settings were merged into a file that already had some. */
  merged: boolean;
}

/** A fresh file, or the existing one with init's settings merged into it. */
async function buildEnvFile(
  io: InitIo,
  ollamaUrl: string,
  secrets: Record<string, string>,
): Promise<EnvFile> {
  const current = await readEnvFile(io);
  if (current === undefined || current.trim() === '') {
    return { text: renderEnvFile(ollamaUrl, secrets), merged: false };
  }
  const updates = envUpdates(current, ollamaUrl, secrets);
  return { text: mergeEnvText(current, updates, io.envPath), merged: true };
}

async function readEnvFile(io: InitIo): Promise<string | undefined> {
  try {
    return await io.readFile(io.envPath);
  } catch (error) {
    throw new DigestError(`Could not read ${io.envPath}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * What init sets in an existing file: every secret it was given, and OLLAMA_URL only when the
 * file has none (a hand-set URL is a choice, such as a remote Ollama). A secret it was not given
 * is left alone.
 */
function envUpdates(
  current: string,
  ollamaUrl: string,
  secrets: Record<string, string>,
): EnvUpdate[] {
  const hasUrl = (parseEnv(current)['OLLAMA_URL'] ?? '') !== '';
  return [
    ...(hasUrl ? [] : [{ key: 'OLLAMA_URL', value: ollamaUrl }]),
    ...Object.entries(secrets).map(([key, value]) => ({ key, value })),
  ];
}

function toJson(input: ConfigInput): string {
  return `${JSON.stringify(input, null, 2)}\n`;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('\n');
}

async function writeOrFail(path: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    throw new DigestError(`Could not write ${path}: ${errorMessage(error)}`, { cause: error });
  }
}

// ---------------------------------------------------------------- output

const DOCKER_NEXT_STEPS =
  '\nNext: "docker compose up -d" starts the weekly schedule. Run "digest doctor" first to check the setup.\n';

/** A container on UTC would run the Monday 07:45 digest at 07:45 UTC, so say how to change it. */
function dockerNextSteps(timeZone: string): string {
  if (!CONTAINER_DEFAULT_ZONES.has(timeZone)) return DOCKER_NEXT_STEPS;
  return `\nThe schedule runs on ${timeZone}. For your local time, set schedule.timeZone in digest.config.json (for example "Europe/Berlin").\n${DOCKER_NEXT_STEPS}`;
}

function summary(info: {
  configPath: string;
  envPath: string;
  answers: Answers;
  ollamaUrl: string;
  envMerged: boolean;
}): string {
  const { answers } = info;
  const channels = [
    'markdown',
    ...(answers.email ? ['email'] : []),
    ...(answers.slackWebhook ? ['slack'] : []),
  ];
  const written = info.envMerged
    ? `Wrote ${info.configPath} and updated ${info.envPath} (kept its other settings; readable by you only).`
    : `Wrote ${info.configPath} and ${info.envPath} (readable by you only).`;
  return [
    written,
    `  profile:  ${answers.profile}`,
    ...(answers.profile === 'quality'
      ? [
          `  note:     ${QUALITY_UNMEASURED}; set "profile" to "light" in ${info.configPath} for a shorter week.`,
        ]
      : []),
    `  focus:    ${answers.focusAreas.join(', ')}`,
    `  delivery: ${channels.join(', ')}`,
    `  schedule: ${info.answers.timeZone}`,
    `  ollama:   ${info.ollamaUrl}`,
    '',
  ].join('\n');
}

function scheduleSection(io: InitIo, configPath: string, cron: string): string {
  try {
    const schedule = io.renderSchedule(io.platform, {
      cron,
      command: scheduleCommand(io, configPath),
      workingDir: io.cwd,
    });
    const content = schedule.content.endsWith('\n') ? schedule.content : `${schedule.content}\n`;
    return `\nTo run the digest weekly, save this as ${schedule.path}:\n\n${content}\n${schedule.installHint}\n`;
  } catch (error) {
    const reason = error instanceof NotImplementedError ? '' : ` (${errorMessage(error)})`;
    return `\nNo OS schedule snippet is available${reason}. Run "digest run" weekly from your scheduler, or keep "digest serve" running.\n`;
  }
}

// ---------------------------------------------------------------- defaults

function isPromptCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'ExitPromptError';
}

const inquirerPrompts: InitPrompts = {
  confirm: (options) => confirm(options),
  checkbox: (options) => checkbox(options),
  input: (options) => input(options),
  select: (options) => select(options),
  password: (options) => password(options),
};

function createDefaultIo(): InitIo {
  return {
    prompts: inquirerPrompts,
    env: process.env,
    platform: process.platform,
    totalMemoryBytes: totalmem(),
    memoryLimitBytes: process.constrainedMemory(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cwd: process.cwd(),
    envPath: DEFAULT_ENV_PATH,
    scheduleProgram: defaultScheduleProgram(),
    renderSchedule: renderOsSchedule,
    exists: pathExists,
    isEmptyFile,
    readFile: readTextIfPresent,
    writeFile: writeTextFile,
    writeSecretFile,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}

/**
 * The command a scheduler can run from any folder: this node binary and script. A TypeScript
 * entry point (a dev run through tsx) cannot be started by plain node, so it falls back to
 * the installed `digest` command.
 */
function defaultScheduleProgram(): string {
  const script = process.argv[1];
  if (!script || /\.[cm]?tsx?$/.test(script)) return 'digest';
  return [process.execPath, resolve(script)].map(quoteIfSpaced).join(' ');
}

/** "<program> [-c <config>] run": a config outside ./digest.config.json is passed on explicitly. */
function scheduleCommand(io: InitIo, configPath: string): string {
  const absoluteConfig = resolve(io.cwd, configPath);
  const isDefault = absoluteConfig === resolve(io.cwd, DEFAULT_CONFIG_PATH);
  return [
    io.scheduleProgram,
    ...(isDefault ? [] : ['-c', quoteIfSpaced(absoluteConfig)]),
    'run',
  ].join(' ');
}

function quoteIfSpaced(part: string): string {
  return /\s/.test(part) ? `"${part}"` : part;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function isEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size === 0;
  } catch {
    // Unreadable counts as "has content": the caller then asks before overwriting.
    return false;
  }
}

/**
 * Writes `content` to a file only its owner can read. The temp file and rename keep readers from
 * seeing half a file; where the rename cannot work (the file is a single-file bind mount, the
 * folder is read-only) the existing file is written in place instead.
 */
async function writeSecretFile(path: string, content: string): Promise<void> {
  try {
    await writeViaTempFile(path, content);
  } catch (error) {
    if (!IN_PLACE_FALLBACK_CODES.has(errorCode(error) ?? '')) throw error;
    await writeInPlace(path, content);
  }
}

/** Creates the file with mode 0600 under a temp name, then renames it over `path`: never readable by others. */
async function writeViaTempFile(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: SECRET_FILE_MODE, flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function writeInPlace(path: string, content: string): Promise<void> {
  await restrictToOwner(path);
  // The mode only applies to a file this call creates.
  await writeFile(path, content, { encoding: 'utf8', mode: SECRET_FILE_MODE });
}

/**
 * Makes an existing file owner-only before secrets go into it. A mount that refuses chmod is
 * fine if the file already is owner-only; a chmod that did nothing is not. Otherwise nothing is
 * written.
 */
async function restrictToOwner(path: string): Promise<void> {
  try {
    await chmod(path, SECRET_FILE_MODE);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    if (await isOwnerOnly(path)) return;
    throw new Error(
      `${path} is readable by others and cannot be restricted (${errorMessage(error)}). ${OWNER_ONLY_HINT}`,
      { cause: error },
    );
  }
  if (!(await isOwnerOnly(path))) {
    throw new Error(`${path} is still readable by others after chmod. ${OWNER_ONLY_HINT}`);
  }
}

async function isOwnerOnly(path: string): Promise<boolean> {
  const { mode } = await stat(path);
  return (mode & GROUP_AND_OTHER_BITS) === 0;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
