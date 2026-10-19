import { describe, expect, it } from 'vitest';
import {
  NON_MAC_FALLBACK,
  PROFILES,
  requiredModels,
  type Platform,
} from '../../../config/profiles';
import type { ModelHealth } from '../../../models/ModelProvider';
import { GIB } from './memory';
import { buildRow, verdictOf, versionStatus } from './rows';

const MAC: Platform = { os: 'darwin', arch: 'arm64' };
const LINUX: Platform = { os: 'linux', arch: 'x64' };
const QUALITY_TAGS = requiredModels(PROFILES.quality);

function healthWith(tags: readonly string[], extra: Partial<ModelHealth> = {}): ModelHealth {
  return {
    reachable: true,
    version: '0.40.4',
    models: tags.map((name) => ({ name, capabilities: [] })),
    ...extra,
  };
}

describe('verdictOf', () => {
  it('is "not for this machine" when the hardware does not fit, whatever is installed', () => {
    expect(verdictOf(false, true)).toBe('not for this machine');
    expect(verdictOf(false, false)).toBe('not for this machine');
  });

  it('is "ready" when the hardware fits and everything is there', () => {
    expect(verdictOf(true, true)).toBe('ready');
  });

  it('is "pull models" when the hardware fits and something is missing', () => {
    expect(verdictOf(true, false)).toBe('pull models');
  });
});

describe('versionStatus', () => {
  const at = (version: string | undefined): ModelHealth => ({
    reachable: true,
    version,
    models: [],
  });

  it('is unknown when Ollama is unreachable or reports no version', () => {
    expect(versionStatus({ reachable: false, models: [] }, '0.40.0')).toBe('unknown');
    expect(versionStatus(at(undefined), '0.40.0')).toBe('unknown');
  });

  it('is unknown for a version it cannot read, and for a development build', () => {
    expect(versionStatus(at('weird'), '0.40.0')).toBe('unknown');
    expect(versionStatus(at('0.0.0'), '0.40.0')).toBe('unknown');
    expect(versionStatus(at('0.40.0'), 'not a version')).toBe('unknown');
  });

  it('is "too old" below the minimum, compared by number', () => {
    expect(versionStatus(at('0.39.9'), '0.40.0')).toBe('too old');
    expect(versionStatus(at('0.9.0'), '0.40.0')).toBe('too old');
  });

  it('is ok at and above the minimum', () => {
    expect(versionStatus(at('0.40.0'), '0.40.0')).toBe('ok');
    expect(versionStatus(at('v0.100.1'), '0.40.0')).toBe('ok');
  });
});

describe('buildRow', () => {
  it('is ready on a big Mac with every model installed', () => {
    const row = buildRow('quality', MAC, 64 * GIB, healthWith(QUALITY_TAGS));

    expect(row).toMatchObject({
      name: 'quality',
      ram: 'yes',
      needsAppleSilicon: true,
      hasAppleSilicon: true,
      version: 'ok',
      installed: QUALITY_TAGS.length,
      total: QUALITY_TAGS.length,
      missing: [],
      verdict: 'ready',
    });
  });

  it('lists the missing tags and counts the installed ones', () => {
    const row = buildRow('quality', MAC, 64 * GIB, healthWith(['clef:latest']));

    expect(row.verdict).toBe('pull models');
    expect(row.installed).toBe(1);
    expect(row.missing).toEqual(QUALITY_TAGS.filter((tag) => tag !== 'clef:latest'));
  });

  it('matches an installed name without a tag to its :latest tag', () => {
    const row = buildRow('quality', MAC, 64 * GIB, healthWith(['clef']));

    expect(row.missing).not.toContain('clef:latest');
  });

  it('counts every tag as missing, and the installed count as unknown, when Ollama is unreachable', () => {
    const row = buildRow('quality', MAC, 64 * GIB, { reachable: false, models: [] });

    expect(row.installed).toBeUndefined();
    expect(row.missing).toEqual(QUALITY_TAGS);
    expect(row.verdict).toBe('pull models');
  });

  it('does the same when Ollama answers but cannot list its models', () => {
    const row = buildRow('quality', MAC, 64 * GIB, healthWith(QUALITY_TAGS, { error: 'HTTP 500' }));

    expect(row.installed).toBeUndefined();
    expect(row.missing).toEqual(QUALITY_TAGS);
  });

  it('asks for a pull when every model is there but Ollama is too old', () => {
    const row = buildRow('quality', MAC, 64 * GIB, healthWith(QUALITY_TAGS, { version: '0.39.0' }));

    expect(row.version).toBe('too old');
    expect(row.verdict).toBe('pull models');
  });

  it('is not for this machine when RAM is short', () => {
    const row = buildRow('quality', MAC, 16 * GIB, healthWith(QUALITY_TAGS));

    expect(row.ram).toBe('no');
    expect(row.verdict).toBe('not for this machine');
  });

  it('is not for this machine when the profile needs Apple silicon and the host has none', () => {
    const row = buildRow('light', LINUX, 64 * GIB, healthWith(QUALITY_TAGS));

    expect(row).toMatchObject({
      needsAppleSilicon: true,
      hasAppleSilicon: false,
      verdict: 'not for this machine',
    });
  });

  it('judges the fallback row with the untuned profile, usable without Apple silicon', () => {
    const tags = requiredModels({ ...NON_MAC_FALLBACK, name: 'light' });

    const row = buildRow('fallback', LINUX, 16 * GIB, healthWith(tags, { version: '0.36.0' }));

    expect(row).toMatchObject({
      name: 'fallback',
      ram: 'maybe',
      needsAppleSilicon: false,
      version: 'ok',
      verdict: 'ready',
    });
  });
});
