import type { LoadedConfig } from '../../../config/load';
import {
  isAppleSilicon,
  PROFILES,
  type ModelProfile,
  type Platform,
} from '../../../config/profiles';
import type { ModelHealth } from '../../../models/ModelProvider';
import { compareCore, DEVELOPMENT_VERSION, parseVersion } from '../readiness/version';
import { fail, ok, warn, type CheckResult } from '../report/checkResult';

// The Ollama server and the machine it runs on.

export function checkOllama(
  health: ModelHealth,
  { env, profile }: Pick<LoadedConfig, 'env' | 'profile'>,
): CheckResult[] {
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

export function checkVersion(version: string | undefined, profile: ModelProfile): CheckResult {
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

export function checkAppleSilicon(
  { config, profile }: Pick<LoadedConfig, 'config' | 'profile'>,
  platform: Platform,
): CheckResult {
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
