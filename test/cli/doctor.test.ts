import { describe, expect, it, vi } from 'vitest';
import { doctorCommand, type DoctorIo } from '../../src/cli/doctor.js';
import type { LoadedConfig } from '../../src/config/load.js';
import {
  PROFILES,
  requiredModels,
  resolveProfile,
  type ModelProfile,
  type Platform,
} from '../../src/config/profiles.js';
import type { ConfigInput, Secrets } from '../../src/config/schema.js';
import { DigestError } from '../../src/shared/errors.js';
import type { ModelHealth } from '../../src/ports/ModelProvider.js';
import { makeConfig } from '../builders.js';
import { FakeModelProvider, fixedClock } from '../fakes/index.js';

const MAC: Platform = { os: 'darwin', arch: 'arm64' };
const LINUX: Platform = { os: 'linux', arch: 'x64' };
const DATA_DIR = '/srv/digest/data';
const ENV_PATH = '/srv/digest/.env';
const FEED_URL = 'https://example.com/feed.xml';
const GITHUB_URL = 'https://github.com/acme/tool';
const ATOM_FEED =
  '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title><id>t</id>' +
  '<updated>2026-10-15T00:00:00Z</updated><entry><title>v1</title><id>a</id>' +
  '<link href="https://github.com/acme/tool/releases/tag/v1"/><updated>2026-10-15T00:00:00Z</updated></entry></feed>';

/** Tags that must be decision models for a profile: classify, guardPolicy and the judge. */
function decisionTags(profile: ModelProfile): string[] {
  return [profile.classify, profile.guardPolicy, ...(profile.judge ? [profile.judge] : [])];
}

function installedFor(profile: ModelProfile, skip: readonly string[] = []): ModelHealth['models'] {
  const decision = new Set(decisionTags(profile));
  return requiredModels(profile)
    .filter((tag) => !skip.includes(tag))
    .map((name) => ({ name, capabilities: decision.has(name) ? ['decision'] : ['completion'] }));
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

interface Setup {
  config?: Partial<ConfigInput>;
  secrets?: Secrets;
  /** Profile the loader resolved; defaults to the configured profile for `platform`. */
  profile?: ModelProfile;
  platform?: Platform;
  health?: Partial<ModelHealth> | ((profile: ModelProfile) => Partial<ModelHealth>);
  /** Mode of the .env file; null when there is no .env. */
  envMode?: number | null;
  envStatError?: Error;
  /** Directories that exist; others fail `access` with ENOENT. */
  existingDirs?: readonly string[];
  /** Directories that exist but are not writable. */
  readOnlyDirs?: readonly string[];
  fetch?: typeof fetch;
  loadConfig?: DoctorIo['loadConfig'];
  sourceTimeoutMs?: number;
}

interface Harness {
  io: Partial<DoctorIo>;
  text: () => string;
  fetch: ReturnType<typeof vi.fn>;
  loadConfig: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
}

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response(ATOM_FEED, { status: 200 }));
}

function harness(setup: Setup = {}): Harness {
  const platform = setup.platform ?? MAC;
  const config = makeConfig({ dataDir: DATA_DIR, ...setup.config });
  const profile = setup.profile ?? resolveProfile(config.profile, platform, config.models.writers);
  const loaded: LoadedConfig = {
    config,
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' },
    secrets: setup.secrets ?? {},
    profile,
    configPath: '/srv/digest/digest.config.json',
  };
  const healthOverride =
    typeof setup.health === 'function' ? setup.health(profile) : (setup.health ?? {});
  const health: ModelHealth = {
    reachable: true,
    version: '0.40.4',
    models: installedFor(profile),
    ...healthOverride,
  };
  const provider = new FakeModelProvider({ health });
  const healthSpy = vi.spyOn(provider, 'health');
  const fetchSpy = vi.fn(setup.fetch ?? okFetch());
  const loadSpy = vi.fn(setup.loadConfig ?? (async () => loaded));
  const existing = new Set(setup.existingDirs ?? ['/', '/srv', '/srv/digest', DATA_DIR]);
  const readOnly = new Set(setup.readOnlyDirs ?? []);
  const out: string[] = [];
  const io: Partial<DoctorIo> = {
    loadConfig: loadSpy,
    createProvider: () => provider,
    fetch: fetchSpy,
    clock: fixedClock('2026-10-16T09:00:00Z'),
    platform,
    envPath: ENV_PATH,
    stat: async (path) => {
      if (setup.envStatError) throw setup.envStatError;
      if (path !== ENV_PATH || setup.envMode === null) throw errnoError('ENOENT');
      return { mode: 0o100000 | (setup.envMode ?? 0o600) };
    },
    access: async (path) => {
      if (!existing.has(path)) throw errnoError('ENOENT');
      if (readOnly.has(path)) throw errnoError('EACCES');
    },
    sourceTimeoutMs: setup.sourceTimeoutMs ?? 200,
    stdout: (text) => {
      out.push(text);
    },
  };
  return {
    io,
    text: () => out.join(''),
    fetch: fetchSpy,
    loadConfig: loadSpy,
    health: healthSpy,
  };
}

/** The result line that starts with `symbol` and mentions `fragment`, plus its fix line. */
function resultFor(text: string, symbol: '✓' | '!' | '✗', fragment: string): string | undefined {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${symbol} `) && line.includes(fragment));
  if (index < 0) return undefined;
  const next = lines[index + 1] ?? '';
  return next.trimStart().startsWith('fix:') ? `${lines[index]}\n${next}` : lines[index];
}

async function runDoctor(setup: Setup = {}): Promise<{ code: number; text: string; h: Harness }> {
  const h = harness(setup);
  const code = await doctorCommand({}, h.io);
  return { code, text: h.text(), h };
}

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

    it('accepts exactly the minimum version and a version with a suffix', async () => {
      const exact = await runDoctor({ health: { version: '0.35.1' } });
      const suffixed = await runDoctor({ health: { version: '0.40.0-rc1' } });

      expect(resultFor(exact.text, '✓', 'ollama version:')).toBeDefined();
      expect(resultFor(suffixed.text, '✓', 'ollama version:')).toBeDefined();
    });

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

  describe('models', () => {
    it('prints ✗ with the pull command for each missing model', async () => {
      const { code, text } = await runDoctor({
        health: (profile) => ({
          models: installedFor(profile, ['gemma4:31b-mlx', 'granite4.1-guardian:8b']),
        }),
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'model gemma4:31b-mlx:')).toMatch(
        /not installed.*\n\s+fix: ollama pull gemma4:31b-mlx$/,
      );
      expect(resultFor(text, '✗', 'model granite4.1-guardian:8b:')).toMatch(
        /\n\s+fix: ollama pull granite4\.1-guardian:8b$/,
      );
      expect(resultFor(text, '✓', 'model clef:latest:')).toBeDefined();
    });

    it('prints ✗ when a decision model is installed without the decision capability', async () => {
      const { code, text } = await runDoctor({
        health: (profile) => ({
          models: installedFor(profile).map((model) =>
            model.name === 'clef:latest' ? { ...model, capabilities: ['completion'] } : model,
          ),
        }),
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'model clef:latest:')).toMatch(
        /decision.*\n\s+fix: ollama pull clef:latest$/,
      );
    });

    it('does not require the decision capability from writer and Granite models', async () => {
      const { code } = await runDoctor({
        health: (profile) => ({
          models: installedFor(profile).map((model) =>
            model.name === 'clef:latest' ? model : { ...model, capabilities: [] },
          ),
        }),
      });

      expect(code).toBe(0);
    });

    it('checks the strands-decider decision models of the fast profile', async () => {
      const { code, text } = await runDoctor({
        config: { profile: 'fast' },
        health: (profile) => ({
          version: '0.40.0',
          models: installedFor(profile).map((model) =>
            model.name === 'strands-decider:2b-mlx-bf16' ? { ...model, capabilities: [] } : model,
          ),
        }),
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'model strands-decider:2b-mlx-bf16:')).toBeDefined();
    });

    it('does not mistake a registry port for a version tag', async () => {
      const tag = 'localhost:5000/team/writer';
      const { code, text } = await runDoctor({
        config: { models: { writers: [tag] } },
        health: (profile) => ({
          models: [...installedFor(profile), { name: `${tag}:latest`, capabilities: [] }],
        }),
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', `model ${tag}:`)).toBeDefined();
    });

    it('treats a tag without a version as :latest', async () => {
      const { code, text } = await runDoctor({
        config: { models: { writers: ['my-writer'] } },
        health: (profile) => ({
          models: [...installedFor(profile), { name: 'my-writer:latest', capabilities: [] }],
        }),
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'model my-writer:')).toBeDefined();
    });

    it('checks the configured writer override instead of the profile writers', async () => {
      const { text } = await runDoctor({
        config: { models: { writers: ['gemma4:31b'] } },
        health: (profile) => ({ models: installedFor(profile) }),
      });

      expect(resultFor(text, '✓', 'model gemma4:31b:')).toBeDefined();
      expect(text).not.toContain('gemma4:31b-mlx');
    });
  });

  describe('sources', () => {
    it('reads every source through the real fetchers with a one-day window', async () => {
      const { h } = await runDoctor({
        config: {
          sources: [
            { id: 'example-feed', kind: 'rss', url: FEED_URL },
            { id: 'acme-tool', kind: 'github', url: GITHUB_URL },
          ],
        },
      });

      const urls = h.fetch.mock.calls.map(([input]) => String(input));
      expect(urls).toEqual([FEED_URL, `${GITHUB_URL}/releases.atom`]);
    });

    it('prints ! naming the source for an HTTP failure and still returns 0', async () => {
      const { code, text } = await runDoctor({
        fetch: async () => new Response('gone', { status: 404 }),
      });

      expect(code).toBe(0);
      expect(resultFor(text, '!', 'source example-feed:')).toMatch(
        /404.*\n\s+fix: .*(feed|source).*digest\.config\.json/i,
      );
    });

    it('prints ! for a feed that cannot be parsed', async () => {
      const { code, text } = await runDoctor({
        fetch: async () => new Response('<html>not a feed</html>', { status: 200 }),
      });

      expect(code).toBe(0);
      expect(resultFor(text, '!', 'source example-feed:')).toBeDefined();
    });

    it('prints ! when a source does not answer within the timeout', async () => {
      const { code, text } = await runDoctor({
        sourceTimeoutMs: 20,
        fetch: () => new Promise<Response>(() => undefined),
      });

      expect(code).toBe(0);
      expect(resultFor(text, '!', 'source example-feed:')).toMatch(/timed out/i);
    });

    it('reports each source on its own and keeps config order', async () => {
      const { text } = await runDoctor({
        config: {
          sources: [
            { id: 'first', kind: 'rss', url: 'https://one.example.com/feed.xml' },
            { id: 'second', kind: 'rss', url: 'https://two.example.com/feed.xml' },
            { id: 'third', kind: 'rss', url: 'https://three.example.com/feed.xml' },
          ],
        },
        fetch: async (input) =>
          urlOf(input).startsWith('https://two.')
            ? new Response('no', { status: 500 })
            : new Response(ATOM_FEED, { status: 200 }),
      });

      expect(resultFor(text, '✓', 'source first:')).toBeDefined();
      expect(resultFor(text, '!', 'source second:')).toBeDefined();
      expect(resultFor(text, '✓', 'source third:')).toBeDefined();
      expect(text.indexOf('source first')).toBeLessThan(text.indexOf('source second'));
      expect(text.indexOf('source second')).toBeLessThan(text.indexOf('source third'));
    });

    it('never prints the source URL or credentials embedded in a URL', async () => {
      const privateUrl = 'https://user:s3cret@feeds.example.com/f.xml?token=abc123';
      const { text } = await runDoctor({
        config: { sources: [{ id: 'priv', kind: 'rss', url: privateUrl }] },
        fetch: async () => new Response('no', { status: 401 }),
        health: { error: `Ollama at http://u:pw@localhost:11434 failed`, models: [] },
      });

      expect(text).not.toMatch(/s3cret|abc123|u:pw@/);
      expect(resultFor(text, '!', 'source priv:')).toContain('401');
      expect(text).toContain('http://localhost:11434 failed');
    });

    it('never prints a secret that appears in a source error', async () => {
      const { text } = await runDoctor({
        secrets: { GITHUB_TOKEN: 'ghp_supersecrettoken' },
        fetch: async () => {
          throw new Error('request failed with token ghp_supersecrettoken');
        },
      });

      expect(text).not.toContain('ghp_supersecrettoken');
      expect(resultFor(text, '!', 'source example-feed:')).toContain('[redacted]');
    });
  });

  describe('delivery', () => {
    const email = {
      host: 'smtp.example.com',
      user: 'digest',
      from: 'digest@example.com',
      to: ['me@example.com'],
    };

    it('prints ✗ when email is configured without SMTP_PASSWORD', async () => {
      const { code, text } = await runDoctor({ config: { delivery: { email } } });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'email:')).toMatch(
        /SMTP_PASSWORD.*\n\s+fix: .*SMTP_PASSWORD.*\.env/,
      );
    });

    it('prints ✓ when email is configured and SMTP_PASSWORD is present', async () => {
      const { code, text } = await runDoctor({
        config: { delivery: { email } },
        secrets: { SMTP_PASSWORD: 'hunter2-password' },
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'email:')).toBeDefined();
      expect(text).not.toContain('hunter2-password');
    });

    it('prints ✗ when Slack is enabled without SLACK_WEBHOOK_URL', async () => {
      const { code, text } = await runDoctor({
        config: { delivery: { slack: { enabled: true } } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'slack:')).toMatch(/SLACK_WEBHOOK_URL.*\n\s+fix: .*\.env/);
    });

    it('prints ✓ when Slack is enabled and the webhook is present, without printing it', async () => {
      const webhook = 'https://hooks.slack.com/services/T000/B000/secretvalue';
      const { code, text } = await runDoctor({
        config: { delivery: { slack: { enabled: true } } },
        secrets: { SLACK_WEBHOOK_URL: webhook },
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'slack:')).toBeDefined();
      expect(text).not.toContain('secretvalue');
    });

    it('does not check Slack when it is disabled', async () => {
      const { text } = await runDoctor({ config: { delivery: { slack: { enabled: false } } } });

      expect(text).not.toContain('slack:');
    });

    it('never sends anything: only the source feeds are contacted', async () => {
      const { h } = await runDoctor({
        config: { delivery: { email, slack: { enabled: true } } },
        secrets: {
          SMTP_PASSWORD: 'hunter2-password',
          SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T000/B000/secretvalue',
        },
      });

      expect(h.fetch.mock.calls.map(([input]) => String(input))).toEqual([FEED_URL]);
    });
  });

  describe('.env permissions', () => {
    it.each([0o644, 0o640, 0o604, 0o666])(
      'prints ! with chmod 600 when .env has mode %o',
      async (mode) => {
        const { code, text } = await runDoctor({ envMode: mode });

        expect(code).toBe(0);
        expect(resultFor(text, '!', '.env:')).toMatch(
          /readable by other users.*\n\s+fix: chmod 600 \.env$/,
        );
      },
    );

    it.each([0o600, 0o400, 0o700])('prints ✓ when .env has mode %o', async (mode) => {
      const { text } = await runDoctor({ envMode: mode });

      expect(resultFor(text, '✓', '.env:')).toBeDefined();
    });

    it('prints ✓ when there is no .env file', async () => {
      const { code, text } = await runDoctor({ envMode: null });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', '.env:')).toMatch(/no \.env file/i);
    });

    it('prints ! when .env cannot be inspected', async () => {
      const { code, text } = await runDoctor({ envStatError: errnoError('EACCES') });

      expect(code).toBe(0);
      expect(resultFor(text, '!', '.env:')).toContain('EACCES');
    });
  });

  describe('guards', () => {
    it('prints ! naming every check of a disabled input section', async () => {
      const { code, text } = await runDoctor({ config: { guards: { input: { enabled: false } } } });

      expect(code).toBe(0);
      const line = resultFor(text, '!', 'guards:');
      expect(line).toContain('clefPolicy');
      expect(line).toContain('graniteRisk');
      expect(line).toMatch(/\n\s+fix: .*digest\.config\.json/);
    });

    it('prints ! naming only the single check that is off', async () => {
      const { text } = await runDoctor({
        config: { guards: { output: { checks: { clefRubric: false } } } },
      });

      const line = resultFor(text, '!', 'guards:');
      expect(line).toContain('clefRubric');
      expect(line).not.toContain('graniteGroundedness');
    });

    it('names input and output checks together', async () => {
      const { text } = await runDoctor({
        config: {
          guards: {
            input: { checks: { graniteRisk: false } },
            output: { enabled: false },
          },
        },
      });

      const line = resultFor(text, '!', 'guards:');
      for (const check of ['graniteRisk', 'graniteGroundedness', 'clefRubric']) {
        expect(line).toContain(check);
      }
      expect(line).not.toContain('clefPolicy');
    });

    it('prints ✓ when every guard is on', async () => {
      const { text } = await runDoctor();

      expect(resultFor(text, '✓', 'guards:')).toMatch(/all .*on/i);
    });
  });

  describe('data directory', () => {
    it('prints ✗ with a fix when dataDir exists but is not writable', async () => {
      const { code, text } = await runDoctor({ readOnlyDirs: [DATA_DIR] });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toMatch(new RegExp(`${DATA_DIR}.*\\n\\s+fix: `));
    });

    it('prints ✓ when dataDir does not exist yet but its parent is writable', async () => {
      const { code, text } = await runDoctor({ existingDirs: ['/', '/srv', '/srv/digest'] });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'data dir:')).toMatch(/created|does not exist yet/i);
    });

    it('prints ✗ when dataDir does not exist and the nearest existing parent is read-only', async () => {
      const { code, text } = await runDoctor({
        existingDirs: ['/', '/srv', '/srv/digest'],
        readOnlyDirs: ['/srv/digest'],
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toContain('/srv/digest');
    });

    it('prints ✗ when no parent exists at all', async () => {
      const { code, text } = await runDoctor({ existingDirs: [] });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'data dir:')).toBeDefined();
    });
  });

  describe('exit code and summary', () => {
    it('returns 0 and counts warnings when there are only warnings', async () => {
      const { code, text } = await runDoctor({
        envMode: 0o644,
        config: { guards: { input: { enabled: false } } },
      });

      expect(code).toBe(0);
      expect(text).toMatch(/0 errors, 2 warnings/);
    });

    it('returns 1 and counts errors when any check fails', async () => {
      const { code, text } = await runDoctor({
        readOnlyDirs: [DATA_DIR],
        envMode: 0o644,
      });

      expect(code).toBe(1);
      expect(text).toMatch(/1 error, 1 warning\b/);
    });
  });
});
