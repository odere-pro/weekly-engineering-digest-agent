import { describe, expect, it } from 'vitest';
import {
  EVAL_JUDGE,
  MODEL_TAGS,
  PROFILES,
  modelsByRole,
  modelsForRole,
  requiredModels,
  resolveProfile,
} from '../../src/config/profiles.js';

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
