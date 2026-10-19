import {
  isAppleSilicon,
  NON_MAC_FALLBACK,
  PROFILES,
  requiredModels,
  type ModelProfile,
  type Platform,
} from '../../../config/profiles';
import type { ModelHealth } from '../../../models/ModelProvider';
import { fitsRam, type RamFit, type RowName } from './memory';
import { compareCore, DEVELOPMENT_VERSION, normalizeTag, parseVersion } from './version';

/** `tight on RAM`: everything is there and it fits, but only just (`quality` at 32 GiB swapped). */
export type Verdict = 'ready' | 'tight on RAM' | 'pull models' | 'not for this machine';
export type VersionStatus = 'ok' | 'too old' | 'unknown';

/** One line of the readiness table: a profile (or the fallback) judged against this machine. */
export interface ProfileRow {
  name: RowName;
  profile: Omit<ModelProfile, 'name'>;
  ram: RamFit;
  needsAppleSilicon: boolean;
  hasAppleSilicon: boolean;
  version: VersionStatus;
  /** undefined when Ollama could not list its models. */
  installed: number | undefined;
  total: number;
  missing: string[];
  verdict: Verdict;
}

export function buildRow(
  name: RowName,
  platform: Platform,
  totalMemoryBytes: number,
  health: ModelHealth,
): ProfileRow {
  const profile = name === 'fallback' ? NON_MAC_FALLBACK : PROFILES[name];
  const tags = requiredModels({ ...profile, name: 'light' });
  const listed = health.reachable && !health.error;
  const have = new Set(health.models.map((m) => normalizeTag(m.name)));
  const missing = listed ? tags.filter((tag) => !have.has(normalizeTag(tag))) : [...tags];
  const ram = fitsRam(name, totalMemoryBytes);
  const hasAppleSilicon = isAppleSilicon(platform);
  const version = versionStatus(health, profile.minOllamaVersion);
  const fitsHardware = ram !== 'no' && (!profile.requiresAppleSilicon || hasAppleSilicon);
  return {
    name,
    profile,
    ram,
    needsAppleSilicon: profile.requiresAppleSilicon,
    hasAppleSilicon,
    version,
    installed: listed ? tags.length - missing.length : undefined,
    total: tags.length,
    missing,
    verdict: verdictOf(
      fitsHardware,
      listed && version !== 'too old' && missing.length === 0,
      ram === 'tight',
    ),
  };
}

/** Hardware first, then what is left to pull; only a complete setup can be `ready` or `tight on RAM`. */
export function verdictOf(fitsHardware: boolean, complete: boolean, tightRam = false): Verdict {
  if (!fitsHardware) return 'not for this machine';
  if (!complete) return 'pull models';
  return tightRam ? 'tight on RAM' : 'ready';
}

export function versionStatus(health: ModelHealth, minimum: string): VersionStatus {
  if (!health.reachable || health.version === undefined) return 'unknown';
  const actual = parseVersion(health.version);
  const required = parseVersion(minimum);
  if (!actual || !required) return 'unknown';
  if (compareCore(actual.core, DEVELOPMENT_VERSION) === 0) return 'unknown';
  return compareCore(actual.core, required.core) < 0 ? 'too old' : 'ok';
}
