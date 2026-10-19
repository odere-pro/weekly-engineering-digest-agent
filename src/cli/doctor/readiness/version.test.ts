import { describe, expect, it } from 'vitest';
import { compareCore, DEVELOPMENT_VERSION, normalizeTag, parseVersion } from './version';

describe('version helpers', () => {
  it('parses plain, v-prefixed and pre-release versions', () => {
    expect(parseVersion('0.40.4')?.core).toEqual([0, 40, 4]);
    expect(parseVersion('v1.2.3')?.core).toEqual([1, 2, 3]);
    expect(parseVersion('0.40.0-rc1')?.prerelease).toBe(true);
    expect(parseVersion('0.40.0')?.prerelease).toBe(false);
    expect(parseVersion('nonsense')).toBeUndefined();
  });

  it('treats build metadata as no pre-release, and surrounding space as nothing', () => {
    expect(parseVersion('0.40.0+build5')?.prerelease).toBe(false);
    expect(parseVersion('  0.40.4\n')?.core).toEqual([0, 40, 4]);
  });

  it('reads a bare letter suffix as a pre-release', () => {
    expect(parseVersion('0.40.0rc1')?.prerelease).toBe(true);
  });

  it('compares cores', () => {
    expect(compareCore([0, 40, 0], [0, 40, 0])).toBe(0);
    expect(compareCore([0, 39, 9], [0, 40, 0])).toBeLessThan(0);
    expect(compareCore([1, 0, 0], [0, 40, 0])).toBeGreaterThan(0);
  });

  it('compares numerically, not as text', () => {
    expect(compareCore([0, 100, 1], [0, 40, 0])).toBeGreaterThan(0);
    expect(compareCore([0, 9, 0], [0, 40, 0])).toBeLessThan(0);
  });

  it('names the development build 0.0.0', () => {
    expect(compareCore(parseVersion('v0.0.0-dev')?.core ?? [1, 0, 0], DEVELOPMENT_VERSION)).toBe(0);
  });

  it('normalizeTag adds :latest to an untagged name only', () => {
    expect(normalizeTag('clef')).toBe('clef:latest');
    expect(normalizeTag('clef:latest')).toBe('clef:latest');
    expect(normalizeTag('host:5000/x')).toBe('host:5000/x:latest');
  });

  it('normalizeTag leaves a tagged name behind a registry port alone', () => {
    expect(normalizeTag('host:5000/team/writer:7b')).toBe('host:5000/team/writer:7b');
  });
});
