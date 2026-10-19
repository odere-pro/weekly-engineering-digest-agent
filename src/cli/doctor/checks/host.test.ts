import { describe, expect, it } from 'vitest';
import { PROFILES } from '../../../config/profiles';
import { LINUX, loadedFor, MAC, resultFor, runDoctor } from '../__fixtures__/doctorHarness';
import { checkAppleSilicon, checkOllama, checkVersion } from './host';

describe('checkVersion', () => {
  const profile = PROFILES.quality; // minimum 0.40.0

  it.each([
    ['0.40.0', 'ok'],
    ['0.41.2', 'ok'],
    ['v0.40.2', 'ok'],
    ['0.100.1', 'ok'],
    ['0.39.9', 'error'],
    ['0.9.0', 'error'],
    ['0.39.9-rc1', 'error'],
    ['0.40.0-rc2', 'warn'],
    ['0.0.0', 'warn'],
    ['dev-build', 'warn'],
  ])('rates %s as %s against a minimum of 0.40.0', (version, severity) => {
    expect(checkVersion(version, profile).severity).toBe(severity);
  });

  it('warns, with the install fix, when Ollama reports no version', () => {
    const result = checkVersion(undefined, profile);

    expect(result.severity).toBe('warn');
    expect(result.message).toBe('Ollama did not report a version');
    expect(result.fix).toBe(
      'install Ollama 0.40.0 or later (update the app, or "brew upgrade ollama")',
    );
  });

  it('names the version and the minimum when it is too old', () => {
    expect(checkVersion('0.39.9', profile).message).toBe(
      'Ollama 0.39.9 is older than 0.40.0, the minimum for this profile',
    );
  });

  it('judges against the minimum of the profile it is given', () => {
    const fallback = { ...PROFILES.quality, minOllamaVersion: '0.35.1' };

    expect(checkVersion('0.36.0', fallback).severity).toBe('ok');
    expect(checkVersion('0.36.0', profile).severity).toBe('error');
  });
});

describe('checkOllama', () => {
  const loaded = loadedFor();

  it('fails with the start-Ollama fix, and nothing else, when the server does not answer', () => {
    const results = checkOllama({ reachable: false, models: [] }, loaded);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ severity: 'error', label: 'ollama', message: 'no answer' });
    expect(results[0]?.fix).toContain('ollama serve');
  });

  it('shows the reason the server gave when it does not answer', () => {
    const results = checkOllama(
      { reachable: false, models: [], error: 'connection refused' },
      loaded,
    );

    expect(results[0]?.message).toBe('connection refused');
  });

  it('fails, and skips the version check, when the model list failed', () => {
    const results = checkOllama({ reachable: true, models: [], error: 'HTTP 500' }, loaded);

    expect(results).toHaveLength(1);
    expect(results[0]?.message).toBe('answered, but listing the models failed: HTTP 500');
  });

  it('returns the reachable line and the version check', () => {
    const results = checkOllama({ reachable: true, version: '0.40.4', models: [] }, loaded);

    expect(results.map((r) => r.label)).toEqual(['ollama', 'ollama version']);
    expect(results[0]?.message).toBe('reachable at http://localhost:11434, version 0.40.4');
  });

  it('leaves the version out of the reachable line when there is none', () => {
    const results = checkOllama({ reachable: true, models: [] }, loaded);

    expect(results[0]?.message).toBe('reachable at http://localhost:11434');
    expect(results[1]?.severity).toBe('warn');
  });
});

describe('checkAppleSilicon', () => {
  it('is ok on Apple silicon and names the platform', () => {
    const result = checkAppleSilicon(loadedFor({ platform: MAC }), MAC);

    expect(result).toMatchObject({ severity: 'ok', message: 'found (darwin/arm64)' });
  });

  it('fails when the profile in use needs Apple silicon and the host has none', () => {
    const loaded = loadedFor({ platform: LINUX, profile: PROFILES.quality });

    const result = checkAppleSilicon(loaded, LINUX);

    expect(result.severity).toBe('error');
    expect(result.message).toContain('profile quality needs Apple silicon');
    expect(result.message).toContain('this is linux/x64');
  });

  it('warns that a profile fell back to the untuned one', () => {
    const result = checkAppleSilicon(loadedFor({ platform: LINUX }), LINUX);

    expect(result.severity).toBe('warn');
    expect(result.message).toBe(
      'profile quality needs Apple silicon; linux/x64 falls back to the untuned profile',
    );
  });

  it('judges the host it is given, not the one on the loaded config', () => {
    const loaded = loadedFor({ platform: MAC });

    expect(checkAppleSilicon(loaded, LINUX).severity).toBe('error');
  });
});

describe('doctor host checks', () => {
  describe('ollama', () => {
    it('prints ✗ with a fix when Ollama is not reachable and skips the model checks', async () => {
      const { code, text } = await runDoctor({
        health: {
          reachable: false,
          models: [],
          error: 'Ollama is not reachable at http://localhost:11434.',
        },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'ollama:')).toMatch(
        /not reachable.*\n\s+fix: .*ollama serve.*OLLAMA_URL/,
      );
      expect(text).not.toContain('model clef:latest');
      expect(text).not.toContain('ollama version');
    });

    it('prints ✗ when Ollama answers but cannot list its models', async () => {
      const { code, text } = await runDoctor({
        health: { models: [], error: 'GET /api/tags failed with HTTP 500' },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'ollama:')).toMatch(
        /HTTP 500.*\n\s+fix: check the Ollama server log/,
      );
      expect(text).not.toContain('model clef:latest');
    });

    it('prints ✗ with an upgrade fix when the version is older than the profile minimum', async () => {
      const { code, text } = await runDoctor({
        config: { profile: 'fast' },
        health: { version: '0.39.9' },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'ollama version:')).toMatch(
        /0\.39\.9.*0\.40\.0.*\n\s+fix: .*(update|upgrade).*Ollama/i,
      );
    });

    it('compares versions numerically, not as text', async () => {
      const old = await runDoctor({ health: { version: '0.9.0' } });
      const newer = await runDoctor({
        config: { profile: 'fast' },
        health: { version: '0.100.1' },
      });

      expect(resultFor(old.text, '✗', 'ollama version:')).toBeDefined();
      expect(resultFor(newer.text, '✓', 'ollama version:')).toBeDefined();
    });

    it('accepts exactly the minimum version, a "v" prefix and build metadata', async () => {
      for (const version of ['0.40.0', 'v0.40.2', '0.40.0+build5']) {
        const { text } = await runDoctor({ health: { version } });

        expect(resultFor(text, '✓', 'ollama version:'), version).toBeDefined();
      }
    });

    it('accepts a pre-release of a version newer than the minimum', async () => {
      const { code, text } = await runDoctor({ health: { version: '0.41.0-rc1' } });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'ollama version:')).toContain('0.41.0-rc1');
    });

    it('warns about a pre-release of the minimum itself: it may lack what the release added', async () => {
      const { code, text } = await runDoctor({ health: { version: '0.40.0-rc2' } });

      expect(code).toBe(0);
      expect(resultFor(text, '!', 'ollama version:')).toMatch(
        /0\.40\.0-rc2.*pre-release.*0\.40\.0.*\n\s+fix: install Ollama 0\.40\.0 or later/,
      );
    });

    it('fails a pre-release of a version older than the minimum', async () => {
      const { code, text } = await runDoctor({ health: { version: '0.39.9-rc1' } });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'ollama version:')).toContain('0.39.9-rc1');
    });

    it.each(['0.0.0', '0.0.0-dev', 'v0.0.0'])(
      'warns, not fails, for %s, which is how a development build reports itself',
      async (version) => {
        const { code, text } = await runDoctor({ health: { version } });

        expect(code).toBe(0);
        expect(resultFor(text, '!', 'ollama version:')).toMatch(
          /development build.*cannot be checked.*\n\s+fix: /,
        );
        expect(text).not.toContain('older than');
      },
    );

    it('prints ! when the version cannot be read', async () => {
      const { code, text } = await runDoctor({ health: { version: 'dev-build' } });

      expect(code).toBe(0);
      expect(resultFor(text, '!', 'ollama version:')).toContain('dev-build');
    });

    it('prints ! when Ollama reports no version', async () => {
      const { code, text } = await runDoctor({ health: { version: undefined } });

      expect(code).toBe(0);
      expect(resultFor(text, '!', 'ollama version:')).toBeDefined();
    });
  });

  describe('apple silicon', () => {
    it('prints ✗ when the profile in use needs Apple silicon and the machine lacks it', async () => {
      const { code, text } = await runDoctor({ platform: LINUX, profile: PROFILES.quality });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'apple silicon:')).toMatch(/\n\s+fix: /);
    });

    it('prints ! when a profile that needs Apple silicon fell back to the untuned profile', async () => {
      const { code, text } = await runDoctor({ platform: LINUX });

      expect(resultFor(text, '!', 'apple silicon:')).toMatch(/fall(s|ing)? back.*\n\s+fix: /i);
      expect(resultFor(text, '✓', 'model gemma4:31b:')).toBeDefined();
      expect(code).toBe(0);
    });

    it('warns that light becomes the heavy fallback off a Mac, and needs far more than 16 GB', async () => {
      const { code, text } = await runDoctor({ platform: LINUX, config: { profile: 'light' } });

      const line = resultFor(text, '!', 'apple silicon:');
      expect(line).toContain('profile light');
      expect(line).toContain('linux/x64');
      expect(line).toContain('clef:latest');
      expect(line).toContain('gemma4:31b');
      expect(line).toMatch(/much more than the 16 GB/);
      expect(line).toMatch(/\n\s+fix: /);
      expect(code).toBe(0);
    });

    it('does not talk about 16 GB for the other profiles that fall back', async () => {
      const { text } = await runDoctor({ platform: LINUX, config: { profile: 'fast' } });

      const line = resultFor(text, '!', 'apple silicon:');
      expect(line).toContain('falls back');
      expect(line).not.toContain('16 GB');
    });

    it('says nothing about the fallback for light on Apple silicon', async () => {
      const { text } = await runDoctor({ platform: MAC, config: { profile: 'light' } });

      expect(resultFor(text, '✓', 'apple silicon:')).toBeDefined();
      expect(text).not.toContain('16 GB');
    });

    it('prints ✓ on Apple silicon', async () => {
      const { text } = await runDoctor({ platform: MAC });

      expect(resultFor(text, '✓', 'apple silicon:')).toBeDefined();
    });

    it('reports an Intel Mac as not Apple silicon', async () => {
      const { text } = await runDoctor({
        platform: { os: 'darwin', arch: 'x64' },
        profile: PROFILES.fast,
      });

      expect(resultFor(text, '✗', 'apple silicon:')).toBeDefined();
    });
  });
});
