import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/load';
import { PROFILES } from '../../config/profiles';
import { DigestError } from '../../shared/errors';
import { doctorCommand } from './doctor';
import type { DoctorIo } from './types';
import {
  ENV_PATH,
  FEED_URL,
  GITHUB_URL,
  LINUX,
  MAC,
  MISSING_ENV,
  VALID_CONFIG,
  harness,
  onProcess,
  resultFor,
  runDoctor,
} from './__fixtures__/doctorHarness';

describe('doctorCommand', () => {
  describe('all green', () => {
    it('returns 0 and prints only ✓ results for a healthy machine', async () => {
      const { code, text } = await runDoctor();

      expect(code).toBe(0);
      expect(text).toContain('✓');
      expect(text).not.toMatch(/^[!✗] /m);
      expect(text).toContain('all checks passed');
    });

    it('checks every part of the contract once', async () => {
      const { text } = await runDoctor({
        config: {
          sources: [
            { id: 'example-feed', kind: 'rss', url: FEED_URL },
            { id: 'acme-tool', kind: 'github', url: GITHUB_URL },
          ],
        },
      });

      for (const label of [
        'config',
        'ollama',
        'ollama version',
        'apple silicon',
        'model clef:latest',
        'model gemma4:31b-mlx',
        'model granite4.1-guardian:8b',
        'source example-feed',
        'source acme-tool',
        'markdown',
        '.env',
        'guards',
        'schedule',
        'data dir',
      ]) {
        expect(resultFor(text, '✓', `${label}:`), label).toBeDefined();
      }
    });

    it('passes the config path and platform to the loader', async () => {
      const h = harness();

      await doctorCommand({ config: 'custom.config.json' }, h.io);

      expect(h.loadConfig).toHaveBeenCalledWith({
        configPath: 'custom.config.json',
        envPath: ENV_PATH,
        platform: MAC,
      });
    });
  });

  describe('config', () => {
    it('prints ✗ with a fix, returns 1 and runs nothing else when the config does not load', async () => {
      const h = harness({
        loadConfig: async () => {
          throw new DigestError('No digest.config.json found at /x. Run "digest init" first.');
        },
      });

      const code = await doctorCommand({}, h.io);

      expect(code).toBe(1);
      expect(resultFor(h.text(), '✗', 'config:')).toMatch(
        /No digest\.config\.json found.*\n\s+fix: .*digest init/,
      );
      expect(h.health).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
    });

    it('reports a non-DigestError load failure instead of crashing', async () => {
      const { code, text } = await runDoctor({
        loadConfig: async () => {
          throw new TypeError('boom');
        },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'config:')).toContain('boom');
    });
  });

  describe('a source URL with credentials in it', () => {
    const CREDENTIAL_URL = 'https://user:s3cret@feeds.example.com/f.xml?token=abc123';
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'digest-doctor-creds-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function doctorOnConfigWith(url: string): Promise<{ code: number; text: string }> {
      const configPath = join(dir, 'digest.config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          focusAreas: ['AI models and tooling'],
          sources: [{ id: 'priv', kind: 'rss', url }],
          schedule: { timeZone: 'Europe/Berlin' },
        }),
      );
      const h = harness({
        loadConfig: (options) => loadConfig({ ...options, envPath: MISSING_ENV, processEnv: {} }),
      });
      const code = await doctorCommand({ config: configPath }, h.io);
      expect(h.fetch).not.toHaveBeenCalled();
      return { code, text: h.text() };
    }

    it('fails the config check and names the field, never the URL or the secret', async () => {
      const { code, text } = await doctorOnConfigWith(CREDENTIAL_URL);

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'config:')).toContain('Invalid config');
      expect(text).toContain('at sources[0].url');
      expect(text).toMatch(/username or password/);
      expect(text).not.toMatch(/s3cret|abc123|feeds\.example\.com|user:/);
    });

    it('runs no other check, since the config is not usable', async () => {
      const { text } = await doctorOnConfigWith(CREDENTIAL_URL);

      expect(text).not.toContain('source priv');
      expect(text).not.toContain('ollama');
    });
  });

  describe('host platform from the environment', () => {
    describe('with the real loader', () => {
      const realLoader =
        (hostEnv: Record<string, string>): DoctorIo['loadConfig'] =>
        (options) =>
          loadConfig({ ...options, envPath: MISSING_ENV, processEnv: hostEnv });

      it('judges the same Mac host the loader resolved the profile for', async () => {
        const h = harness({
          hostEnv: {},
          loadConfig: realLoader({ DIGEST_HOST_OS: 'Darwin', DIGEST_HOST_ARCH: 'arm64' }),
        });

        await onProcess(LINUX, () => doctorCommand({ config: VALID_CONFIG }, h.io));

        expect(resultFor(h.text(), '✓', 'apple silicon:')).toContain('darwin/arm64');
      });

      it('judges the same Linux host the loader fell back for', async () => {
        const h = harness({
          hostEnv: {},
          loadConfig: realLoader({ DIGEST_HOST_OS: 'Linux', DIGEST_HOST_ARCH: 'x86_64' }),
        });

        await onProcess(MAC, () => doctorCommand({ config: VALID_CONFIG }, h.io));

        expect(resultFor(h.text(), '!', 'apple silicon:')).toContain('linux/x64');
      });

      it('prints a readable ✗ naming the variable for a bad value, and checks nothing else', async () => {
        const h = harness({ hostEnv: {}, loadConfig: realLoader({ DIGEST_HOST_OS: 'plan9' }) });

        const code = await doctorCommand({ config: VALID_CONFIG }, h.io);

        expect(code).toBe(1);
        expect(resultFor(h.text(), '✗', 'config:')).toMatch(
          /DIGEST_HOST_OS "plan9".*\n\s+fix: .*variable named above/,
        );
        expect(h.health).not.toHaveBeenCalled();
        expect(h.fetch).not.toHaveBeenCalled();
      });
    });

    it('judges the platform on the loaded config, not one recomputed from the environment', async () => {
      const { text } = await onProcess(MAC, () =>
        runDoctor({
          hostEnv: { DIGEST_HOST_OS: 'darwin', DIGEST_HOST_ARCH: 'arm64' },
          loadedPlatform: LINUX,
          profile: PROFILES.quality,
        }),
      );

      expect(resultFor(text, '✗', 'apple silicon:')).toContain('linux/x64');
    });

    it('leaves the platform to the loader instead of passing one', async () => {
      const h = harness({ hostEnv: { DIGEST_HOST_OS: 'darwin' } });

      await doctorCommand({}, h.io);

      expect(h.loadConfig.mock.calls[0]?.[0].platform).toBeUndefined();
    });
  });
});
