import { describe, expect, it } from 'vitest';
import { PROFILES } from '../../../config/profiles';
import { DigestError } from '../../../shared/errors';
import { resolveModel } from './resolveModel';

describe('resolveModel', () => {
  it('returns the explicit model over the one the profile has for the role', () => {
    expect(resolveModel(PROFILES.light, 'write', 'nemotron-3.5-lightning:30b-mlx')).toBe(
      'nemotron-3.5-lightning:30b-mlx',
    );
  });

  it('returns the first model the profile has for the role', () => {
    expect(resolveModel(PROFILES.light, 'write')).toBe('gemma4:e4b-mlx');
    expect(resolveModel(PROFILES.quality, 'judge')).toBe('clef:latest');
  });

  it('throws a DigestError naming the role and the profile when the role has no model', () => {
    const attempt = (): string => resolveModel(PROFILES.light, 'judge');
    expect(attempt).toThrow(DigestError);
    expect(attempt).toThrow('No model is configured for role judge in profile light');
  });

  it('does not look at the profile when the model is explicit', () => {
    expect(resolveModel(PROFILES.light, 'judge', 'clef:latest')).toBe('clef:latest');
  });
});
