import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createOllamaProvider,
  DEFAULT_THINK,
  type ThinkSetting,
} from '../adapters/models/ollama.js';
import { createGithubReleasesFetcher } from '../adapters/sources/githubReleases.js';
import { createRssFetcher } from '../adapters/sources/rss.js';
import {
  loadConfig,
  redactSecrets,
  resolveHostPlatform,
  type LoadedConfig,
  type LoadOptions,
} from '../config/load.js';
import {
  isAppleSilicon,
  PROFILES,
  requiredModels,
  type ModelProfile,
  type Platform,
} from '../config/profiles.js';
import type { GuardsConfig } from '../config/schema.js';
import type { GuardCheckId, Role, Source, SourceKind } from '../core/schemas.js';
import type { ModelHealth, ModelProvider } from '../ports/ModelProvider.js';
import type { SourceFetcher } from '../ports/SourceFetcher.js';
import { systemClock, type Clock } from '../shared/clock.js';
import { errorMessage } from '../shared/errors.js';
import { withTimeout } from '../shared/retry.js';
import { noopLogger } from '../shared/telemetry.js';

export interface DoctorCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
}

/** Everything the command touches outside itself; tests replace it, `digest doctor` uses the defaults. */
export interface DoctorIo {
  loadConfig: (options: LoadOptions) => Promise<LoadedConfig>;
  createProvider: (loaded: LoadedConfig, fetchImpl: typeof fetch) => ModelProvider;
  fetch: typeof fetch;
  clock: Clock;
  /** Default: the host named in DIGEST_HOST_OS/DIGEST_HOST_ARCH, else the running process. */
  platform?: Platform;
  /** The .env file to inspect; also where the loader reads secrets from. */
  envPath: string;
  stat: (path: string) => Promise<{ mode: number }>;
  /** Resolves when `path` is writable, rejects otherwise (ENOENT when it does not exist). */
  access: (path: string) => Promise<void>;
  /** Per-source timeout for the reachability read. */
  sourceTimeoutMs: number;
  stdout: (text: string) => void;
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
const URL_CREDENTIALS = /(\bhttps?:\/\/)[^\s/@]+@/g;
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)/;
const INPUT_CHECKS = ['clefPolicy', 'graniteRisk'] as const satisfies readonly GuardCheckId[];
const OUTPUT_CHECKS = [
  'graniteGroundedness',
  'clefRubric',
] as const satisfies readonly GuardCheckId[];

const defaultIo: DoctorIo = {
  loadConfig: (options) => loadConfig(options),
  createProvider: (loaded, fetchImpl) =>
    createOllamaProvider({
      baseUrl: loaded.env.OLLAMA_URL,
      profile: loaded.profile,
      fetch: fetchImpl,
      logger: noopLogger,
    }),
  fetch: (input, init) => globalThis.fetch(input, init),
  clock: systemClock,
  envPath: '.env',
  stat: async (path) => {
    const { mode } = await stat(path);
    return { mode };
  },
  access: (path) => access(path, constants.W_OK),
  sourceTimeoutMs: SOURCE_TIMEOUT_MS,
  stdout: (text) => {
    process.stdout.write(text);
  },
};

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
  const loaded = await tryLoadConfig(options, io);
  if ('result' in loaded) return report([loaded.result], io, {});

  const { config, profile } = loaded.value;
  const health = await io.createProvider(loaded.value, io.fetch).health();
  const results: CheckResult[] = [
    ok('config', `loaded ${loaded.value.configPath} (profile ${config.profile})`),
    ...checkOllama(health, loaded.value),
    checkAppleSilicon(loaded.value, loaded.platform),
    ...checkModels(health, profile),
    checkThink(loaded.value),
    ...(await checkSources(loaded.value, io)),
    ...checkDelivery(loaded.value),
    await checkEnvFile(io),
    checkGuards(config.guards),
    await checkDataDir(resolve(config.dataDir), io),
  ];
  return report(results, io, loaded.value.secrets);
}

/** `platform` is the one the loader resolved the profile for, so the checks judge the same host. */
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
    return { value, platform: io.platform ?? resolveHostPlatform(value.env) };
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
  if (compareVersions(actual, required) < 0) {
    return fail(
      label,
      `Ollama ${version} is older than ${minimum}, the minimum for this profile`,
      fix,
    );
  }
  return ok(label, `${version} (minimum ${minimum})`);
}

type Version = readonly [number, number, number];

function parseVersion(text: string): Version | undefined {
  const match = VERSION_PATTERN.exec(text);
  if (!match) return undefined;
  const [, major = '0', minor = '0', patch = '0'] = match;
  return [Number(major), Number(minor), Number(patch)];
}

function compareVersions(a: Version, b: Version): number {
  const index = a.findIndex((part, i) => part !== b[i]);
  return index < 0 ? 0 : (a[index] ?? 0) - (b[index] ?? 0);
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
  return warn(
    label,
    `profile ${config.profile} needs Apple silicon; ${where} falls back to the untuned profile`,
    'run on an Apple silicon Mac for the tuned models',
  );
}

function checkModels(health: ModelHealth, profile: ModelProfile): CheckResult[] {
  if (!health.reachable || health.error) return [];
  const installed = new Map(health.models.map((m) => [normalizeTag(m.name), m.capabilities]));
  const decisionTags = new Set(
    [profile.classify, profile.guardPolicy, ...(profile.judge ? [profile.judge] : [])].map(
      normalizeTag,
    ),
  );
  return requiredModels(profile).map((tag) =>
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
    (role) => `${role}=${describeThink(config.models.think?.[role] ?? DEFAULT_THINK[role])}`,
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

/** Ollama lists an untagged name as ":latest". */
function normalizeTag(tag: string): string {
  const name = tag.slice(tag.lastIndexOf('/') + 1); // a registry port ("host:5000/x") is not a version
  return name.includes(':') ? tag : `${tag}:latest`;
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

function checkDelivery({ config, secrets }: LoadedConfig): CheckResult[] {
  const { email, slack, markdown } = config.delivery;
  return [
    ok('markdown', `digests are written to ${markdown.dir}`),
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

/** A missing data directory is fine when the nearest existing parent is writable: a run creates it. */
async function checkDataDir(dataDir: string, io: DoctorIo): Promise<CheckResult> {
  const label = 'data dir';
  const fix = `make ${dataDir} writable ("chmod u+w"), or set "dataDir" in digest.config.json`;
  for (let current = dataDir; ; current = dirname(current)) {
    try {
      await io.access(current);
      return ok(
        label,
        current === dataDir
          ? `${dataDir} is writable`
          : `${dataDir} does not exist yet; ${current} is writable, so a run creates it`,
      );
    } catch (error) {
      if (!isNotFound(error)) {
        return fail(label, `cannot write to ${current}: ${errorMessage(error)}`, fix);
      }
      if (dirname(current) === current) {
        return fail(label, `${dataDir} does not exist and has no existing parent`, fix);
      }
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
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

/** `https://user:pass@host` becomes `https://host`: credentials in a URL must not reach pasted output. */
function withoutUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, '$1');
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
