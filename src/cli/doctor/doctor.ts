import { constants, type Stats } from 'node:fs';
import { access, lstat, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { effectiveThink, type ThinkSetting } from '../../models/adapters/ollama';
import { createGithubReleasesFetcher } from '../../sources/adapters/githubReleases';
import { createRssFetcher } from '../../sources/adapters/rss';
import { createModelProvider } from '../../app/container';
import {
  loadConfig,
  platformOf,
  redactSecrets,
  type LoadedConfig,
  type LoadOptions,
} from '../../config/load';
import {
  isAppleSilicon,
  modelsInUse,
  PROFILES,
  type ModelProfile,
  type Platform,
} from '../../config/profiles';
import type { GuardsConfig } from '../../config/schema';
import type { GuardCheckId, Role, Source, SourceKind } from '../../domain/schemas';
import type { ModelHealth, ModelProvider } from '../../models/ModelProvider';
import type { SourceFetcher } from '../../sources/SourceFetcher';
import { systemClock, type Clock } from '../../shared/clock';
import { errorMessage } from '../../shared/errors';
import { withTimeout } from '../../shared/retry';
import { noopLogger } from '../../shared/telemetry';
import {
  compareCore,
  DEVELOPMENT_VERSION,
  normalizeTag,
  parseVersion,
  readinessCommand,
  withoutUrlCredentials,
  type ReadinessIo,
} from './readiness';

export interface DoctorCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Print the machine summary and a verdict per profile instead of the checks. */
  readiness?: boolean;
}

/** What doctor asks the disk about a path. */
export interface PathInfo {
  mode: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** Everything the command touches outside itself; tests replace it, `digest doctor` uses the defaults. */
export interface DoctorIo {
  loadConfig: (options: LoadOptions) => Promise<LoadedConfig>;
  /** The one place doctor builds a model provider; only `health()` is called on it. */
  createProvider: (loaded: LoadedConfig, fetchImpl: typeof fetch) => ModelProvider;
  fetch: typeof fetch;
  clock: Clock;
  /** Passed to the loader. Default: the host named in DIGEST_HOST_OS/DIGEST_HOST_ARCH, else the running process. */
  platform?: Platform;
  /** The .env file to inspect; also where the loader reads secrets from. */
  envPath: string;
  /** Follows symbolic links; rejects with ENOENT when the path (or a link's target) is missing. */
  stat: (path: string) => Promise<PathInfo>;
  /** Does not follow a symbolic link, so a link can be told from what it points at. */
  lstat: (path: string) => Promise<PathInfo>;
  /** The text of a file; rejects with ENOENT when it does not exist. */
  readFile: (path: string) => Promise<string>;
  /** Resolves when `path` is writable, rejects otherwise (ENOENT when it does not exist). */
  access: (path: string) => Promise<void>;
  /** Per-source timeout for the reachability read. */
  sourceTimeoutMs: number;
  stdout: (text: string) => void;
  /** Replaces parts of the `--readiness` mode's I/O (platform, memory, disk, Ollama); tests only. */
  readiness?: Partial<ReadinessIo>;
}

type Severity = 'ok' | 'warn' | 'error';

interface CheckResult {
  severity: Severity;
  label: string;
  message: string;
  /** One line telling the user what to do; shown for warnings and errors. */
  fix?: string;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const SOURCE_TIMEOUT_MS = 10_000;
const ONE_DAY_MS = 86_400_000;
const OTHERS_PERMISSION_MASK = 0o077;
const PERMISSION_MASK = 0o777;
const OCTAL = 8;
const SYMBOLS: Readonly<Record<Severity, string>> = { ok: '✓', warn: '!', error: '✗' };
/** node:util parseEnv reads an unquoted value up to its first "#". */
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;
const ENV_QUOTES: ReadonlySet<string> = new Set(['"', "'", '`']);
const INPUT_CHECKS = ['clefPolicy', 'graniteRisk'] as const satisfies readonly GuardCheckId[];
const OUTPUT_CHECKS = [
  'graniteGroundedness',
  'clefRubric',
] as const satisfies readonly GuardCheckId[];

const defaultIo: DoctorIo = {
  loadConfig: (options) => loadConfig(options),
  createProvider: (loaded, fetchImpl) =>
    createModelProvider(loaded, { logger: noopLogger, fetch: fetchImpl }),
  fetch: (input, init) => globalThis.fetch(input, init),
  clock: systemClock,
  envPath: '.env',
  stat: async (path) => toPathInfo(await stat(path)),
  lstat: async (path) => toPathInfo(await lstat(path)),
  readFile: (path) => readFile(path, 'utf8'),
  access: (path) => access(path, constants.W_OK),
  sourceTimeoutMs: SOURCE_TIMEOUT_MS,
  stdout: (text) => {
    process.stdout.write(text);
  },
};

function toPathInfo(stats: Stats): PathInfo {
  return {
    mode: stats.mode,
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
  };
}

const ok = (label: string, message: string): CheckResult => ({
  severity: 'ok',
  label,
  message,
});
const warn = (label: string, message: string, fix: string): CheckResult => ({
  severity: 'warn',
  label,
  message,
  fix,
});
const fail = (label: string, message: string, fix: string): CheckResult => ({
  severity: 'error',
  label,
  message,
  fix,
});

/** `digest doctor`: Checks Ollama, the models, every feed and delivery; prints what to fix (W1-19). Returns the process exit code. */
export async function doctorCommand(
  options: DoctorCommandOptions,
  overrides: Partial<DoctorIo> = {},
): Promise<number> {
  const io: DoctorIo = { ...defaultIo, ...overrides };
  if (options.readiness) return runReadiness(options, io);
  const loaded = await tryLoadConfig(options, io);
  if ('result' in loaded) return report([loaded.result], io, {});

  const { config, profile } = loaded.value;
  const health = await io.createProvider(loaded.value, io.fetch).health();
  const results: CheckResult[] = [
    ok('config', `loaded ${loaded.value.configPath} (profile ${config.profile})`),
    ...checkOllama(health, loaded.value),
    // The platform the loader resolved the profile for, so the checks judge the same host.
    checkAppleSilicon(loaded.value, loaded.platform),
    ...checkModels(health, profile, config.guards),
    checkThink(loaded.value),
    ...(await checkSources(loaded.value, io)),
    ...(await checkDelivery(loaded.value, io)),
    await checkEnvFile(io),
    ...(await checkEnvValues(io)),
    checkGuards(config.guards),
    await checkWritableDir(dataDirCheck(config.dataDir), io),
  ];
  return report(results, io, loaded.value.secrets);
}

function runReadiness(options: DoctorCommandOptions, io: DoctorIo): Promise<number> {
  return readinessCommand(
    { config: options.config },
    {
      loadConfig: io.loadConfig,
      envPath: io.envPath,
      stdout: io.stdout,
      ...(io.platform ? { platform: io.platform } : {}),
      ...io.readiness,
    },
  );
}

/** `platform` is the host the loader resolved the profile for (a bad DIGEST_HOST_* is reported here). */
async function tryLoadConfig(
  options: DoctorCommandOptions,
  io: DoctorIo,
): Promise<{ value: LoadedConfig; platform: Platform } | { result: CheckResult }> {
  try {
    const value = await io.loadConfig({
      configPath: options.config,
      envPath: io.envPath,
      platform: io.platform,
    });
    return { value, platform: platformOf(value) };
  } catch (error) {
    return {
      result: fail(
        'config',
        errorMessage(error),
        'fix the file or variable named above, or run "digest init" to create a config',
      ),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Ollama, platform and models

function checkOllama(health: ModelHealth, { env, profile }: LoadedConfig): CheckResult[] {
  if (!health.reachable) {
    const fix = 'start Ollama ("ollama serve") or point OLLAMA_URL in .env at the right host';
    return [fail('ollama', health.error ?? 'no answer', fix)];
  }
  if (health.error) {
    const message = `answered, but listing the models failed: ${health.error}`;
    return [fail('ollama', message, 'check the Ollama server log, then restart Ollama')];
  }
  const where = `reachable at ${env.OLLAMA_URL}`;
  return [
    ok('ollama', health.version ? `${where}, version ${health.version}` : where),
    checkVersion(health.version, profile),
  ];
}

function checkVersion(version: string | undefined, profile: ModelProfile): CheckResult {
  const label = 'ollama version';
  const minimum = profile.minOllamaVersion;
  const fix = `install Ollama ${minimum} or later (update the app, or "brew upgrade ollama")`;
  if (version === undefined) return warn(label, 'Ollama did not report a version', fix);

  const actual = parseVersion(version);
  const required = parseVersion(minimum);
  if (!actual || !required) return warn(label, `cannot read the version "${version}"`, fix);
  if (compareCore(actual.core, DEVELOPMENT_VERSION) === 0) {
    const message = `Ollama reports ${version}, which is how a development build reports itself; the minimum (${minimum}) cannot be checked`;
    return warn(label, message, fix);
  }
  const order = compareCore(actual.core, required.core);
  if (order < 0) {
    return fail(
      label,
      `Ollama ${version} is older than ${minimum}, the minimum for this profile`,
      fix,
    );
  }
  if (order === 0 && actual.prerelease) {
    const message = `Ollama ${version} is a pre-release of ${minimum}, the minimum for this profile; it may lack what the final release added`;
    return warn(label, message, fix);
  }
  return ok(label, `${version} (minimum ${minimum})`);
}

function checkAppleSilicon({ config, profile }: LoadedConfig, platform: Platform): CheckResult {
  const label = 'apple silicon';
  const configuredNeedsIt = PROFILES[config.profile].requiresAppleSilicon;
  const where = `${platform.os}/${platform.arch}`;
  if (!profile.requiresAppleSilicon && !configuredNeedsIt) {
    return ok(label, `not required by profile ${config.profile}`);
  }
  if (isAppleSilicon(platform)) return ok(label, `found (${where})`);
  if (profile.requiresAppleSilicon) {
    return fail(
      label,
      `profile ${profile.name} needs Apple silicon (its models are MLX builds); this is ${where}`,
      'run on an Apple silicon Mac, or set "profile" in digest.config.json to one this machine supports',
    );
  }
  const fallsBack = `profile ${config.profile} needs Apple silicon; ${where} falls back to the untuned profile`;
  if (config.profile !== 'light') {
    return warn(label, fallsBack, 'run on an Apple silicon Mac for the tuned models');
  }
  // light is the 16 GB profile only on a Mac; elsewhere it is the heavy fallback.
  const heavy = [...new Set([profile.classify, ...profile.writers])].join(' and ');
  return warn(
    label,
    `${fallsBack} (${heavy}), which needs much more than the 16 GB that light is meant for`,
    'run on an Apple silicon Mac for the small models, or check that this machine has the memory for the larger ones',
  );
}

/** The models a run would load with these guard settings; a switched-off guard needs no model. */
function checkModels(
  health: ModelHealth,
  profile: ModelProfile,
  guards: GuardsConfig,
): CheckResult[] {
  if (!health.reachable || health.error) return [];
  const installed = new Map(health.models.map((m) => [normalizeTag(m.name), m.capabilities]));
  const decisionTags = new Set(
    [profile.classify, profile.guardPolicy, ...(profile.judge ? [profile.judge] : [])].map(
      normalizeTag,
    ),
  );
  return modelsInUse(profile, guards).map((tag) =>
    checkModel(tag, installed.get(normalizeTag(tag)), decisionTags.has(normalizeTag(tag))),
  );
}

function checkModel(
  tag: string,
  capabilities: readonly string[] | undefined,
  needsDecision: boolean,
): CheckResult {
  const label = `model ${tag}`;
  const pull = `ollama pull ${tag}`;
  if (capabilities === undefined) return fail(label, 'not installed', pull);
  if (needsDecision && !capabilities.includes('decision')) {
    return fail(
      label,
      'installed, but it is not a decision model (no "decision" capability)',
      pull,
    );
  }
  return ok(label, needsDecision ? 'installed (decision model)' : 'installed');
}

/**
 * Roles whose calls can reach `generate`, the only path that sends `think` (classify only in
 * generate mode). guardPolicy and judge use `decide`, which ignores it.
 */
const THINK_ROLES = ['classify', 'guardRisk', 'write'] as const satisfies readonly Role[];
const DECISION_ONLY_ROLES = ['guardPolicy', 'judge'] as const satisfies readonly Role[];

/** The effective `think` per role: the config, else the adapter default, else the model's own. */
function checkThink({ config }: LoadedConfig): CheckResult {
  const label = 'think';
  const settings = THINK_ROLES.map(
    (role) => `${role}=${describeThink(effectiveThink(config.models.think, role))}`,
  ).join(', ');
  const ignored = DECISION_ONLY_ROLES.filter((role) => config.models.think?.[role] !== undefined);
  if (ignored.length === 0) return ok(label, settings);
  return warn(
    label,
    `${settings}; ignored for ${ignored.join(', ')}, which take no think setting`,
    'remove those roles from "models" > "think" in digest.config.json',
  );
}

function describeThink(setting: ThinkSetting | undefined): string {
  if (setting === undefined) return 'default';
  if (typeof setting === 'boolean') return setting ? 'on' : 'off';
  return setting;
}

// ---------------------------------------------------------------------------------------------
// Sources, delivery, secrets file, guards, data directory

async function checkSources(loaded: LoadedConfig, io: DoctorIo): Promise<CheckResult[]> {
  const fetchers: Record<SourceKind, SourceFetcher> = {
    rss: createRssFetcher({ fetch: io.fetch }),
    github: createGithubReleasesFetcher({ fetch: io.fetch, token: loaded.secrets.GITHUB_TOKEN }),
  };
  return Promise.all(loaded.config.sources.map((source) => checkSource(source, fetchers, io)));
}

async function checkSource(
  source: Source,
  fetchers: Readonly<Record<SourceKind, SourceFetcher>>,
  io: DoctorIo,
): Promise<CheckResult> {
  const label = `source ${source.id}`;
  const until = io.clock.now();
  const window = { since: new Date(until.getTime() - ONE_DAY_MS), until, maxItems: 1 };
  try {
    await withTimeout(
      (signal) => fetchers[source.kind].fetch(source, window, signal),
      io.sourceTimeoutMs,
    );
    return ok(label, 'reachable and readable');
  } catch (error) {
    return warn(
      label,
      errorMessage(error),
      'check the URL, or remove the source from digest.config.json (a run skips it)',
    );
  }
}

async function checkDelivery(
  { config, secrets }: LoadedConfig,
  io: DoctorIo,
): Promise<CheckResult[]> {
  const { email, slack, markdown } = config.delivery;
  return [
    await checkWritableDir(markdownDirCheck(markdown.dir), io),
    ...(email
      ? [
          secrets.SMTP_PASSWORD
            ? ok(
                'email',
                `SMTP_PASSWORD is set (${email.to.length} recipient(s) via ${email.host})`,
              )
            : fail(
                'email',
                'email delivery is configured but SMTP_PASSWORD is not set',
                'add SMTP_PASSWORD=<password> to .env',
              ),
        ]
      : []),
    ...(slack?.enabled
      ? [
          secrets.SLACK_WEBHOOK_URL
            ? ok('slack', 'SLACK_WEBHOOK_URL is set')
            : fail(
                'slack',
                'Slack delivery is enabled but SLACK_WEBHOOK_URL is not set',
                'add SLACK_WEBHOOK_URL=<webhook url> to .env',
              ),
        ]
      : []),
  ];
}

async function checkEnvFile(io: DoctorIo): Promise<CheckResult> {
  const label = '.env';
  try {
    const { mode } = await io.stat(io.envPath);
    if ((mode & OTHERS_PERMISSION_MASK) === 0) return ok(label, 'readable only by you');
    const shown = (mode & PERMISSION_MASK).toString(OCTAL);
    return warn(label, `readable by other users (mode ${shown})`, 'chmod 600 .env');
  } catch (error) {
    if (isNotFound(error)) {
      return ok(label, 'no .env file (secrets come from the process environment)');
    }
    return warn(
      label,
      `cannot inspect ${io.envPath}: ${errorMessage(error)}`,
      'check that .env exists and that you can read it',
    );
  }
}

function checkGuards(guards: GuardsConfig): CheckResult {
  const label = 'guards';
  const off = [
    ...INPUT_CHECKS.filter((check) => !guards.input.enabled || !guards.input.checks[check]),
    ...OUTPUT_CHECKS.filter((check) => !guards.output.enabled || !guards.output.checks[check]),
  ];
  if (off.length === 0) return ok(label, 'all guards on');
  return warn(
    label,
    `off: ${off.join(', ')}; the digest footer will say so`,
    'turn them back on under "guards" in digest.config.json',
  );
}

/**
 * `.env` values that node's parser cut at a "#": it reads an unquoted value only up to its first
 * "#" (a password `pa#ss` becomes `pa`) and never says so. A warning names the keys and the lines,
 * never a value.
 */
async function checkEnvValues(io: DoctorIo): Promise<CheckResult[]> {
  const label = '.env values';
  let text: string;
  try {
    text = await io.readFile(io.envPath);
  } catch (error) {
    if (isNotFound(error)) return []; // the .env check already says there is none
    return [
      warn(
        label,
        `cannot read ${io.envPath}: ${errorMessage(error)}`,
        'check that you can read .env',
      ),
    ];
  }
  const cut = keysCutAtHash(text);
  if (cut.length === 0) return [ok(label, 'no unquoted value contains a "#"')];
  const where = cut.map(({ key, line }) => `${key} (line ${line})`).join(', ');
  return [
    warn(
      label,
      `${where}: the unquoted value has a "#", and everything from it on is read as a comment; if the "#" belongs to the value, it is cut short`,
      'put the value in quotes if the "#" is part of it, for example KEY="pass#word"',
    ),
  ];
}

/**
 * Each key (first line only) whose unquoted value contains a "#". The parser ends a quoted value
 * at the next same quote character, on a later line if need be, and keeps a quote that nothing
 * closes as plain text; the scan does the same, so it never skips lines the parser reads.
 */
function keysCutAtHash(text: string): { key: string; line: number }[] {
  const found = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const [, key, rest] = ENV_ASSIGNMENT.exec(lines[index] ?? '') ?? [];
    if (key === undefined || rest === undefined) continue;
    const value = rest.trimStart();
    const quote = value.charAt(0);
    if (!ENV_QUOTES.has(quote)) {
      if (value.includes('#') && !found.has(key)) found.set(key, index + 1);
      continue;
    }
    const afterQuote = [value.slice(1), ...lines.slice(index + 1)].join('\n');
    const closeAt = afterQuote.indexOf(quote);
    if (closeAt !== -1) index += afterQuote.slice(0, closeAt).split('\n').length - 1;
  }
  return [...found].map(([key, line]) => ({ key, line }));
}

interface DirCheck {
  label: string;
  /** Absolute. */
  dir: string;
  /** The config key that moves it, named in the fix. */
  setting: string;
  /** The message when the folder exists and is writable. */
  writable: string;
  /** The message when it is missing but `parent` is writable, so a run creates it. */
  creatable: (parent: string) => string;
}

function dataDirCheck(dataDir: string): DirCheck {
  const dir = resolve(dataDir);
  return {
    label: 'data dir',
    dir,
    setting: 'dataDir',
    writable: `${dir} is writable`,
    creatable: (parent) => `${dir} does not exist yet; ${parent} is writable, so a run creates it`,
  };
}

function markdownDirCheck(markdownDir: string): DirCheck {
  const dir = resolve(markdownDir);
  return {
    label: 'markdown',
    dir,
    setting: 'delivery.markdown.dir',
    writable: `digests are written to ${dir}`,
    creatable: (parent) =>
      `digests are written to ${dir}, which does not exist yet; ${parent} is writable, so a run creates it`,
  };
}

type DirStatus =
  | { kind: 'writable' }
  | { kind: 'creatable'; parent: string }
  | { kind: 'blocked'; problem: string; fix: string };

/**
 * A folder a run writes into. A missing one is fine when the nearest existing parent is
 * writable: the run creates it. A file or a dangling symbolic link in its place is not (mkdir
 * fails), and neither is a file further up the path.
 */
async function checkWritableDir(spec: DirCheck, io: DoctorIo): Promise<CheckResult> {
  const status = await inspectDir(spec, io);
  switch (status.kind) {
    case 'writable':
      return ok(spec.label, spec.writable);
    case 'creatable':
      return ok(spec.label, spec.creatable(status.parent));
    case 'blocked':
      return fail(spec.label, status.problem, status.fix);
  }
}

async function inspectDir({ dir, setting }: DirCheck, io: DoctorIo): Promise<DirStatus> {
  const permissionFix = `make ${dir} writable ("chmod u+w"), or set "${setting}" in digest.config.json`;
  const blocked = (problem: string, culprit?: string): DirStatus => ({
    kind: 'blocked',
    problem,
    fix:
      culprit === undefined
        ? permissionFix
        : `remove or replace ${culprit}, or set "${setting}" in digest.config.json`,
  });
  for (let current = dir; ; current = dirname(current)) {
    let kind: PathKind;
    try {
      kind = await pathKind(current, io);
    } catch (error) {
      return blocked(`cannot inspect ${current}: ${errorMessage(error)}`);
    }
    switch (kind) {
      case 'folder':
        return writableStatus(current, dir, io, blocked);
      case 'file':
        return blocked(
          current === dir
            ? `${dir} is a file, not a folder`
            : `${current} is a file, so ${dir} cannot be created below it`,
          current,
        );
      case 'dangling':
        return blocked(`${current} is a symbolic link to a path that does not exist`, current);
      case 'missing':
        if (dirname(current) === current) {
          return blocked(`${dir} does not exist and has no existing parent`);
        }
    }
  }
}

/** `folder` is the existing folder found: `dir` itself, or its nearest existing parent. */
async function writableStatus(
  folder: string,
  dir: string,
  io: DoctorIo,
  blocked: (problem: string) => DirStatus,
): Promise<DirStatus> {
  try {
    await io.access(folder);
  } catch (error) {
    return blocked(`cannot write to ${folder}: ${errorMessage(error)}`);
  }
  return folder === dir ? { kind: 'writable' } : { kind: 'creatable', parent: folder };
}

/** What is at a path, following a symbolic link to what it points at. */
type PathKind = 'folder' | 'file' | 'dangling' | 'missing';

async function pathKind(path: string, io: DoctorIo): Promise<PathKind> {
  let info: PathInfo;
  try {
    info = await io.lstat(path);
  } catch (error) {
    // ENOTDIR: a parent is a file. Climbing on finds it, so the message can name it.
    if (isNotFound(error) || errorCode(error) === 'ENOTDIR') return 'missing';
    throw error;
  }
  if (!info.isSymbolicLink) return info.isDirectory ? 'folder' : 'file';
  try {
    return (await io.stat(path)).isDirectory ? 'folder' : 'file';
  } catch (error) {
    if (isNotFound(error)) return 'dangling';
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

// ---------------------------------------------------------------------------------------------
// Output

function report(
  results: readonly CheckResult[],
  io: DoctorIo,
  secrets: LoadedConfig['secrets'],
): number {
  const errors = results.filter((r) => r.severity === 'error').length;
  const warnings = results.filter((r) => r.severity === 'warn').length;
  const text = [...results.map(formatResult), '', summary(errors, warnings)].join('\n');
  io.stdout(`${withoutUrlCredentials(redactSecrets(text, secrets))}\n`);
  return errors > 0 ? EXIT_FAILED : EXIT_OK;
}

function formatResult(result: CheckResult): string {
  const [first = '', ...rest] = result.message.split('\n');
  return [
    `${SYMBOLS[result.severity]} ${result.label}: ${first}`,
    ...rest.map((line) => `    ${line}`),
    ...(result.severity !== 'ok' && result.fix ? [`    fix: ${result.fix}`] : []),
  ].join('\n');
}

function summary(errors: number, warnings: number): string {
  if (errors === 0 && warnings === 0) return 'Doctor: all checks passed.';
  const plural = (count: number, noun: string): string =>
    `${count} ${noun}${count === 1 ? '' : 's'}`;
  return `Doctor: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}.`;
}
