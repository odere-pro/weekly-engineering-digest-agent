// Model profiles from the spec. A profile maps each role to an Ollama tag; code only asks for roles.
import type { Role } from '../core/schemas.js';
import type { GuardsConfig, ProfileName } from './schema.js';

export interface ModelProfile {
  name: ProfileName;
  classify: string;
  guardPolicy: string;
  guardRisk: string;
  /** Writer panel in config order; one entry skips the select step. */
  writers: readonly string[];
  /** null when the profile has one writer. */
  judge: string | null;
  /** MLX tags and strands-decider need Apple silicon. */
  requiresAppleSilicon: boolean;
  minOllamaVersion: string;
}

export const MODEL_TAGS = {
  clef: 'clef:latest',
  strandsDecider: 'strands-decider:2b-mlx-bf16',
  graniteGuardian: 'granite4.1-guardian:8b',
  gemma31bMlx: 'gemma4:31b-mlx',
  gemma31b: 'gemma4:31b',
  gemmaE4bMlx: 'gemma4:e4b-mlx',
  nemotronLightningMlx: 'nemotron-3.5-lightning:30b-mlx',
} as const;

/** Judge used by evals for single-writer profiles, on a machine that fits it. */
export const EVAL_JUDGE = MODEL_TAGS.clef;

export const PROFILES: Readonly<Record<ProfileName, ModelProfile>> = {
  quality: {
    name: 'quality',
    classify: MODEL_TAGS.clef,
    guardPolicy: MODEL_TAGS.clef,
    guardRisk: MODEL_TAGS.graniteGuardian,
    writers: [MODEL_TAGS.gemma31bMlx, MODEL_TAGS.nemotronLightningMlx],
    judge: MODEL_TAGS.clef,
    requiresAppleSilicon: true,
    minOllamaVersion: '0.40.0',
  },
  fast: {
    name: 'fast',
    classify: MODEL_TAGS.strandsDecider,
    guardPolicy: MODEL_TAGS.strandsDecider,
    guardRisk: MODEL_TAGS.graniteGuardian,
    writers: [MODEL_TAGS.nemotronLightningMlx],
    judge: null,
    requiresAppleSilicon: true,
    minOllamaVersion: '0.40.0',
  },
  light: {
    name: 'light',
    classify: MODEL_TAGS.strandsDecider,
    guardPolicy: MODEL_TAGS.strandsDecider,
    guardRisk: MODEL_TAGS.graniteGuardian,
    writers: [MODEL_TAGS.gemmaE4bMlx],
    judge: null,
    requiresAppleSilicon: true,
    minOllamaVersion: '0.40.0',
  },
};

/** Untuned fallback for machines without Apple silicon. */
export const NON_MAC_FALLBACK: Omit<ModelProfile, 'name'> = {
  classify: MODEL_TAGS.clef,
  guardPolicy: MODEL_TAGS.clef,
  guardRisk: MODEL_TAGS.graniteGuardian,
  writers: [MODEL_TAGS.gemma31b],
  judge: null,
  requiresAppleSilicon: false,
  minOllamaVersion: '0.35.1',
};

export interface Platform {
  os: NodeJS.Platform;
  arch: string;
}

export function isAppleSilicon(platform: Platform): boolean {
  return platform.os === 'darwin' && platform.arch === 'arm64';
}

/** The profile to run on `platform`, falling back when it needs Apple silicon. */
export function resolveProfile(
  name: ProfileName,
  platform: Platform,
  writersOverride?: readonly string[],
): ModelProfile {
  const base = PROFILES[name];
  const profile =
    base.requiresAppleSilicon && !isAppleSilicon(platform) ? { ...NON_MAC_FALLBACK, name } : base;
  if (!writersOverride) return profile;
  return {
    ...profile,
    writers: writersOverride,
    judge: writersOverride.length > 1 ? (profile.judge ?? EVAL_JUDGE) : null,
  };
}

/** Model tag(s) for a role. `write` returns the whole panel. */
export function modelsForRole(profile: ModelProfile, role: Role): readonly string[] {
  switch (role) {
    case 'classify':
      return [profile.classify];
    case 'guardPolicy':
      return [profile.guardPolicy];
    case 'guardRisk':
      return [profile.guardRisk];
    case 'write':
      return profile.writers;
    case 'judge':
      return profile.judge ? [profile.judge] : [];
  }
}

/** Every distinct tag a profile needs; used by doctor and model pulls. */
export function requiredModels(profile: ModelProfile): string[] {
  const tags = [profile.classify, profile.guardPolicy, profile.guardRisk, ...profile.writers];
  if (profile.judge) tags.push(profile.judge);
  return [...new Set(tags)];
}

/**
 * The guard roles that no enabled check uses. The mapping follows the guard adapters: the Clef
 * checks (clefPolicy, clefRubric) ask the guardPolicy role, the Granite checks (graniteRisk,
 * graniteGroundedness) ask guardRisk. A check runs when its section and the check are both on.
 */
function unusedGuardRoles(guards: GuardsConfig): ReadonlySet<'guardPolicy' | 'guardRisk'> {
  const { input, output } = guards;
  const policyInUse =
    (input.enabled && input.checks.clefPolicy) || (output.enabled && output.checks.clefRubric);
  const riskInUse =
    (input.enabled && input.checks.graniteRisk) ||
    (output.enabled && output.checks.graniteGroundedness);
  const unused = new Set<'guardPolicy' | 'guardRisk'>();
  if (!policyInUse) unused.add('guardPolicy');
  if (!riskInUse) unused.add('guardRisk');
  return unused;
}

/**
 * The tags a run with these guard settings loads: `requiredModels` without the models of guard
 * roles whose checks are all off. A tag another role still uses stays. Meant for doctor and the
 * model health check, so a switched-off guard does not demand a model pull.
 */
export function modelsInUse(profile: ModelProfile, guards: GuardsConfig): string[] {
  const unused = unusedGuardRoles(guards);
  const tags = [profile.classify];
  if (!unused.has('guardPolicy')) tags.push(profile.guardPolicy);
  if (!unused.has('guardRisk')) tags.push(profile.guardRisk);
  tags.push(...profile.writers);
  if (profile.judge) tags.push(profile.judge);
  return [...new Set(tags)];
}

export function modelsByRole(profile: ModelProfile): Record<Role, string | string[] | null> {
  return {
    classify: profile.classify,
    guardPolicy: profile.guardPolicy,
    guardRisk: profile.guardRisk,
    write: [...profile.writers],
    judge: profile.judge,
  };
}
