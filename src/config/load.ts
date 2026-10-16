import type { Config, Env, Secrets } from './schema.js';
import type { ModelProfile, Platform } from './profiles.js';
import { NotImplementedError } from '../shared/errors.js';

export interface LoadOptions {
  /** Default: ./digest.config.json */
  configPath?: string;
  /** Default: ./.env (optional file; process.env wins). */
  envPath?: string;
  /** Default: the running process. */
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
export function loadConfig(_options: LoadOptions = {}): Promise<LoadedConfig> {
  throw new NotImplementedError('W1-14');
}

/** Replaces every secret value found in `text` with "[redacted]" (W1-14). */
export function redactSecrets(_text: string, _secrets: Secrets): string {
  throw new NotImplementedError('W1-14');
}
