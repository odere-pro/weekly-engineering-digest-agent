import { access } from 'node:fs/promises';
import { loadConfig, type LoadOptions } from '../../../src/config/load';
import { DEFAULT_SOURCES } from '../../../src/sources/defaultSources';
import { hasErrorCode } from '../fsErrors';
import type { ResolvedSources } from '../types';

const DEFAULT_CONFIG_PATH = 'digest.config.json';

/** The sources to record: the config's when digest.config.json exists, else the default allowlist. */
export async function resolveSources(options: LoadOptions = {}): Promise<ResolvedSources> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  if (!(await fileExists(configPath))) return { sources: DEFAULT_SOURCES, origin: 'default' };
  // A config that exists but is broken must fail loudly, not quietly fall back to the defaults.
  const loaded = await loadConfig({ ...options, configPath });
  return {
    sources: loaded.config.sources,
    origin: 'config',
    githubToken: loaded.secrets.GITHUB_TOKEN,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}
