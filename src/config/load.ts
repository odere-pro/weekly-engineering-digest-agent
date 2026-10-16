import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { resolveProfile, type ModelProfile, type Platform } from './profiles.js';
import { ConfigSchema, EnvSchema, SecretsSchema } from './schema.js';
import type { Config, Env, Secrets } from './schema.js';
import { DigestError, errorMessage } from '../shared/errors.js';

const DEFAULT_CONFIG_PATH = 'digest.config.json';
const DEFAULT_ENV_PATH = '.env';
const REDACTED = '[redacted]';

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

  return { config, env, secrets, profile, configPath };
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

/** Replaces every secret value found in `text` with "[redacted]" (W1-14). */
export function redactSecrets(text: string, secrets: Secrets): string {
  // Longest first, so a secret that contains another secret is redacted whole.
  const values = Object.values(secrets)
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .sort((a, b) => b.length - a.length);
  return values.reduce((redacted, value) => redacted.replaceAll(value, REDACTED), text);
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
