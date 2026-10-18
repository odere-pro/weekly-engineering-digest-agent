import { describe, expect, it } from 'vitest';
import { GuardsConfigSchema, type GuardsConfig } from './schema';
import {
  EVAL_JUDGE,
  MODEL_TAGS,
  PROFILES,
  modelsByRole,
  modelsForRole,
  modelsInUse,
  requiredModels,
  resolveProfile,
} from './profiles';

const mac = { os: 'darwin' as const, arch: 'arm64' };
const linux = { os: 'linux' as const, arch: 'x64' };

describe('profiles', () => {
  it('quality runs two writers with a judge from another family', () => {
    const p = PROFILES.quality;
    expect(p.writers).toEqual([MODEL_TAGS.gemma31bMlx, MODEL_TAGS.nemotronLightningMlx]);
    expect(p.judge).toBe(MODEL_TAGS.clef);
  });

  it('fast and light have one writer and no judge', () => {
    expect(PROFILES.fast.judge).toBeNull();
    expect(PROFILES.light.writers).toEqual([MODEL_TAGS.gemmaE4bMlx]);
  });

  it('keeps the profile on Apple silicon and falls back elsewhere', () => {
    expect(resolveProfile('light', mac)).toBe(PROFILES.light);
    const fallback = resolveProfile('light', linux);
    expect(fallback).toMatchObject({
      name: 'light',
      classify: MODEL_TAGS.clef,
      writers: [MODEL_TAGS.gemma31b],
    });
  });

  it('applies a writer override and adds a judge for a panel', () => {
    expect(resolveProfile('fast', mac, ['a', 'b']).judge).toBe(EVAL_JUDGE);
    expect(resolveProfile('quality', mac, ['a']).judge).toBeNull();
    expect(resolveProfile('quality', mac, ['a', 'b']).judge).toBe(MODEL_TAGS.clef);
  });

  it('maps roles to models', () => {
    const p = PROFILES.quality;
    expect(modelsForRole(p, 'classify')).toEqual([MODEL_TAGS.clef]);
    expect(modelsForRole(p, 'guardPolicy')).toEqual([MODEL_TAGS.clef]);
    expect(modelsForRole(p, 'guardRisk')).toEqual([MODEL_TAGS.graniteGuardian]);
    expect(modelsForRole(p, 'write')).toHaveLength(2);
    expect(modelsForRole(p, 'judge')).toEqual([MODEL_TAGS.clef]);
    expect(modelsForRole(PROFILES.fast, 'judge')).toEqual([]);
    expect(modelsByRole(PROFILES.fast)).toMatchObject({
      judge: null,
      write: [MODEL_TAGS.nemotronLightningMlx],
    });
  });

  it('lists each required model once', () => {
    expect(requiredModels(PROFILES.quality)).toEqual([
      MODEL_TAGS.clef,
      MODEL_TAGS.graniteGuardian,
      MODEL_TAGS.gemma31bMlx,
      MODEL_TAGS.nemotronLightningMlx,
    ]);
  });
});

describe('modelsInUse', () => {
  const allOn = GuardsConfigSchema.parse({});
  const guards = (input: unknown, output: unknown): GuardsConfig =>
    GuardsConfigSchema.parse({ input, output });
  const off = { enabled: false };

  it('equals requiredModels when every guard is on', () => {
    for (const profile of Object.values(PROFILES)) {
      expect(modelsInUse(profile, allOn)).toEqual(requiredModels(profile));
    }
  });

  it('leaves out the risk model when both Granite checks are off', () => {
    const config = guards(
      { checks: { graniteRisk: false } },
      { checks: { graniteGroundedness: false } },
    );
    expect(modelsInUse(PROFILES.quality, config)).toEqual([
      MODEL_TAGS.clef,
      MODEL_TAGS.gemma31bMlx,
      MODEL_TAGS.nemotronLightningMlx,
    ]);
  });

  it('keeps the risk model while one of its checks (groundedness) is still on', () => {
    const config = guards({ checks: { graniteRisk: false } }, {});
    expect(modelsInUse(PROFILES.quality, config)).toContain(MODEL_TAGS.graniteGuardian);
  });

  it('keeps a policy tag that classify also uses when both Clef checks are off', () => {
    const config = guards({ checks: { clefPolicy: false } }, { checks: { clefRubric: false } });
    // fast: guardPolicy and classify share strands-decider, so the tag stays for classify.
    expect(modelsInUse(PROFILES.fast, config)).toEqual([
      MODEL_TAGS.strandsDecider,
      MODEL_TAGS.graniteGuardian,
      MODEL_TAGS.nemotronLightningMlx,
    ]);
  });

  it('drops a role whose whole section is disabled', () => {
    expect(modelsInUse(PROFILES.quality, guards(off, off))).toEqual([
      MODEL_TAGS.clef,
      MODEL_TAGS.gemma31bMlx,
      MODEL_TAGS.nemotronLightningMlx,
    ]);
  });

  it('drops only the input checks when the input section is off', () => {
    const config = guards(off, { checks: { graniteGroundedness: false } });
    // clefRubric (output) still needs the policy role; the risk role has no check left.
    expect(modelsInUse(PROFILES.light, config)).toEqual([
      MODEL_TAGS.strandsDecider,
      MODEL_TAGS.gemmaE4bMlx,
    ]);
  });

  it('always keeps classify, the writers and the judge', () => {
    const tags = modelsInUse(PROFILES.quality, guards(off, off));
    expect(tags).toContain(PROFILES.quality.classify);
    expect(tags).toEqual(expect.arrayContaining([...PROFILES.quality.writers]));
    expect(tags).toContain(PROFILES.quality.judge);
  });

  it('lists a policy model that differs from classify when its checks are on', () => {
    const profile = { ...PROFILES.fast, guardPolicy: 'policy-only:1b' };
    expect(modelsInUse(profile, allOn)).toContain('policy-only:1b');
    const withoutClef = guards(
      { checks: { clefPolicy: false } },
      { checks: { clefRubric: false } },
    );
    expect(modelsInUse(profile, withoutClef)).not.toContain('policy-only:1b');
  });

  it('does not change requiredModels', () => {
    expect(requiredModels(PROFILES.fast)).toEqual([
      MODEL_TAGS.strandsDecider,
      MODEL_TAGS.graniteGuardian,
      MODEL_TAGS.nemotronLightningMlx,
    ]);
  });
});
