import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { resolveProfile, type ModelProfile, type Platform } from './profiles';
import { ConfigSchema, EnvSchema, SecretsSchema } from './schema';
import type { Config, Env, Secrets } from './schema';
import { createRedactor } from '../observability/redact';
import { DigestError, errorMessage } from '../shared/errors';

const DEFAULT_CONFIG_PATH = 'digest.config.json';
const DEFAULT_ENV_PATH = '.env';

export interface LoadOptions {
  /** Default: ./digest.config.json */
  configPath?: string;
  /** Default: ./.env (optional file; process.env wins). */
  envPath?: string;
  /** Default: DIGEST_HOST_OS/DIGEST_HOST_ARCH when set, else the running process. */
  platform?: Platform;
  /** Default: process.env. */
  processEnv?: Readonly<Record<string, string | undefined>>;
}

export interface LoadedConfig {
  config: Config;
  env: Env;
  secrets: Secrets;
  profile: ModelProfile;
  configPath: string;
  /** The machine the profile was resolved for. */
  platform: Platform;
}

/** Reads and validates digest.config.json and .env with readable errors (W1-14). */
export async function loadConfig(options: LoadOptions = {}): Promise<LoadedConfig> {
  const configPath = resolve(options.configPath ?? DEFAULT_CONFIG_PATH);
  const envPath = resolve(options.envPath ?? DEFAULT_ENV_PATH);

  const config = await readConfig(configPath);
  const merged = await readEnvironment(envPath, options.processEnv ?? process.env);
  const { secrets, env } = parseEnvironment(merged, envPath);
  const platform = options.platform ?? resolveHostPlatform(env);
  const profile = resolveProfile(config.profile, platform, config.models.writers);

  return { config, env, secrets, profile, configPath, platform };
}

/** The platform the profile was resolved for. */
export function platformOf(loaded: Pick<LoadedConfig, 'platform'>): Platform {
  return loaded.platform;
}

/**
 * The machine the models run on. In a container that is not the machine `process` describes:
 * on a Mac, Docker runs Linux while Ollama runs on the host and uses its Apple GPU, so
 * `make docker-*` names the host in DIGEST_HOST_OS/DIGEST_HOST_ARCH (as `uname -s`/`uname -m`
 * print them). A part that is not named comes from `fallback`.
 */
export function resolveHostPlatform(
  env: Pick<Env, 'DIGEST_HOST_OS' | 'DIGEST_HOST_ARCH'>,
  fallback: Platform = { os: process.platform, arch: process.arch },
): Platform {
  // Blank counts as not named, as everywhere else in the environment.
  const hostOs = env.DIGEST_HOST_OS?.trim();
  const hostArch = env.DIGEST_HOST_ARCH?.trim();
  return {
    os: !hostOs
      ? fallback.os
      : parseHostValue('DIGEST_HOST_OS', hostOs, 'darwin, linux or windows', toNodeOs),
    arch: !hostArch
      ? fallback.arch
      : parseHostValue('DIGEST_HOST_ARCH', hostArch, 'arm64 or x86_64', toNodeArch),
  };
}

function parseHostValue<T>(
  variable: string,
  value: string,
  expected: string,
  parse: (spelling: string) => T | undefined,
): T {
  const parsed = parse(value.trim().toLowerCase());
  if (parsed === undefined) {
    throw new DigestError(
      `Invalid ${variable} "${value}": use ${expected} (as "uname" prints it).`,
    );
  }
  return parsed;
}

function toNodeOs(spelling: string): NodeJS.Platform | undefined {
  if (spelling === 'darwin' || spelling === 'linux' || spelling === 'win32') return spelling;
  if (spelling === 'windows' || spelling.startsWith('mingw') || spelling.startsWith('msys')) {
    return 'win32';
  }
  return undefined;
}

function toNodeArch(spelling: string): string | undefined {
  if (spelling === 'arm64' || spelling === 'aarch64') return 'arm64';
  if (spelling === 'x64' || spelling === 'x86_64' || spelling === 'amd64') return 'x64';
  return undefined;
}

/**
 * Replaces every secret value found in `text` with "[redacted]" (W1-14). It is the logger's
 * redactor (observability/redact.ts), so text printed by a command is cleaned the way a log line is.
 */
export function redactSecrets(text: string, secrets: Secrets): string {
  const values = Object.values(secrets).filter(
    (value): value is string => typeof value === 'string',
  );
  return createRedactor(values).text(text);
}

// ---------------------------------------------------------------------------------------------
// Writing .env: kept next to the reader (node:util parseEnv), so the two cannot disagree.

const BARE_ENV_VALUE = /^[\w./:@%+,-]+$/;
/** Also what keeps a key safe to put in a pattern. */
const ENV_KEY = /^[a-z_]\w*$/i;

/** Quotes `value` so that `node:util` parseEnv (the loader's parser) reads it back unchanged. */
export function formatEnvValue(key: string, value: string): string {
  if (BARE_ENV_VALUE.test(value)) return value;
  const unstorable = new DigestError(
    `${key} cannot be stored in .env (a line break, or every kind of quote character). Choose a different value; nothing was written.`,
  );
  if (/[\r\n]/.test(value)) throw unstorable;
  if (!value.includes("'")) return `'${value}'`;
  // Double quotes expand a literal backslash-n, so they are only safe without one.
  if (!value.includes('"') && !value.includes('\\n')) return `"${value}"`;
  if (!value.includes('`')) return `\`${value}\``;
  throw unstorable;
}

/** One `.env` setting to write. `key` is an upper-case variable name; `value` is the raw value. */
export interface EnvUpdate {
  key: string;
  value: string;
}

/**
 * Sets the keys in .env text and touches nothing else: comments, other keys, their order and the
 * line endings stay as they were. A key that is there has each of its lines replaced (`export`
 * kept); one that is not is added at the end. The result must read back, through the loader's own
 * parser, as the old values plus the updates; otherwise a line belonged to a multi-line value
 * and this throws, so that nothing is written. `path` only names the file in the error.
 */
export function mergeEnvText(current: string, updates: readonly EnvUpdate[], path: string): string {
  for (const { key } of updates) {
    if (!ENV_KEY.test(key))
      throw new DigestError(`Cannot write "${key}" to .env: not a variable name.`);
  }
  const unsafe = new DigestError(
    `Could not merge into ${path} safely: a setting init would change spans several lines or sits inside another value. Nothing was written. Edit the file by hand, or move it away and run "digest init" again.`,
  );
  const before = parseEnv(current);
  // Replacing the first line of a multi-line value would leave the rest of it behind.
  if (updates.some(({ key }) => before[key]?.includes('\n'))) throw unsafe;

  const carriage = current.includes('\r\n') ? '\r' : '';
  const finished = current.endsWith('\n');
  // A last line without a newline still gets the carriage return, so a CRLF file stays CRLF.
  const body = finished ? current.slice(0, -1) : `${current}${carriage}`;
  const lines = updates.reduce(
    (acc, { key, value }) => withEnvValue(acc, key, formatEnvValue(key, value), carriage),
    body.split('\n'),
  );
  const merged = `${lines.join('\n')}\n`;
  const expected = {
    ...before,
    ...Object.fromEntries(updates.map((update) => [update.key, update.value])),
  };
  if (!sameEntries(expected, parseEnv(merged))) throw unsafe;
  return merged;
}

function withEnvValue(
  lines: readonly string[],
  key: string,
  formatted: string,
  carriage: string,
): string[] {
  const assignment = new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=`);
  const rewritten = (prefix: string): string => `${prefix}${key}=${formatted}${carriage}`;
  if (!lines.some((line) => assignment.test(line))) return [...lines, rewritten('')];
  return lines.map((line) => {
    const match = assignment.exec(line);
    return match ? rewritten(match[1] ?? '') : line;
  });
}

function sameEntries(
  expected: Readonly<Record<string, string | undefined>>,
  actual: Readonly<Record<string, string | undefined>>,
): boolean {
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length && keys.every((k) => actual[k] === expected[k]);
}

async function readConfig(configPath: string): Promise<Config> {
  const raw = await readTextFile(configPath);
  if (raw === undefined) {
    throw new DigestError(
      `No ${DEFAULT_CONFIG_PATH} found at ${configPath}. Run "digest init" first.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new DigestError(`Invalid JSON in ${configPath}: ${errorMessage(cause)}`, { cause });
  }

  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new DigestError(`Invalid config in ${configPath}:\n${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** The env file overlaid by process env. Empty values count as unset in both. */
async function readEnvironment(
  envPath: string,
  processEnv: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string>> {
  const raw = await readTextFile(envPath);
  const fromFile = raw === undefined ? {} : parseEnv(raw);
  return { ...withoutEmpty(fromFile), ...withoutEmpty(processEnv) };
}

function parseEnvironment(
  merged: Readonly<Record<string, string>>,
  envPath: string,
): { secrets: Secrets; env: Env } {
  const secrets = SecretsSchema.safeParse(merged);
  const env = EnvSchema.safeParse(merged);
  if (secrets.success && env.success) return { secrets: secrets.data, env: env.data };

  // prettifyError reports field names and rules, never the rejected values.
  const problems = [secrets, env].flatMap((result) =>
    result.success ? [] : [z.prettifyError(result.error)],
  );
  throw new DigestError(
    `Invalid environment (${envPath} and process environment):\n${problems.join('\n')}`,
  );
}

function withoutEmpty(
  values: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const entries = Object.entries(values).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
  );
  return Object.fromEntries(entries);
}

/** The file's text, undefined when it does not exist. Other failures are wrapped. */
async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw new DigestError(`Cannot read ${path}: ${errorMessage(cause)}`, { cause });
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
