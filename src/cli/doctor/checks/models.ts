import type { LoadedConfig } from '../../../config/load';
import { modelsInUse, type ModelProfile } from '../../../config/profiles';
import type { GuardsConfig } from '../../../config/schema';
import type { ModelHealth } from '../../../models/ModelProvider';
import { effectiveThink, type ThinkSetting } from '../../../models/adapters/chat/chatSettings';
import type { Role } from '../../../models/roles';
import { normalizeTag } from '../readiness/version';
import { fail, ok, warn, type CheckResult } from '../report/checkResult';

/**
 * Roles whose calls can reach `generate`, the only path that sends `think` (classify only in
 * generate mode). guardPolicy and judge use `decide`, which ignores it.
 */
const THINK_ROLES = ['classify', 'guardRisk', 'write'] as const satisfies readonly Role[];
const DECISION_ONLY_ROLES = ['guardPolicy', 'judge'] as const satisfies readonly Role[];

/** The models a run would load with these guard settings; a switched-off guard needs no model. */
export function checkModels(
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

/** The effective `think` per role: the config, else the adapter default, else the model's own. */
export function checkThink({ config }: Pick<LoadedConfig, 'config'>): CheckResult {
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

export function describeThink(setting: ThinkSetting | undefined): string {
  if (setting === undefined) return 'default';
  if (typeof setting === 'boolean') return setting ? 'on' : 'off';
  return setting;
}
