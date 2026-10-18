import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { assembleMetrics, failedHardGates, type Measurement } from '../../../evals/metrics';
import { METRIC_IDS, ScorecardSchema, type MetricId, type Scorecard } from '../../../evals/schema';
import type { DigestDeps } from '../../digest/runDigest';
import { evalCommand, type EvalCommandIo } from './eval';
import { loadConfig, type LoadedConfig } from '../../config/load';
import { NON_MAC_FALLBACK, PROFILES, type Platform } from '../../config/profiles';
import type { ConfigInput, ProfileName } from '../../config/schema';
import type { ModelHealth } from '../../models/ModelProvider';
import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { makeConfig, makeDraft, makeItem } from '../../../test/builders';
import { FakeModelProvider, fixedClock, noopLogger } from '../../../test/fakes';

function makeScorecard(
  profile: ProfileName,
  overrides: Partial<Record<MetricId, Measurement>> = {},
  judgeAgreement: number | null = 0.9,
): Scorecard {
  const base = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
    MetricId,
    Measurement
  >;
  const metrics = assembleMetrics({ ...base, ...overrides }, judgeAgreement);
  return {
    profile,
    date: '2026-10-16T09:00:00.000Z',
    weeks: ['2026-W40', '2026-W41'],
    counts: { weeks: 2, classifier: 60, attacks: 10, grounding: 10 },
    judgeAgreement,
    models: { classify: 'clef:latest', judge: null },
    metrics,
    hardGatesPassed: failedHardGates(metrics).length === 0,
    timings: { totalMs: 12_345, byWeekMs: { '2026-W40': 6000, '2026-W41': 6345 } },
  };
}

interface Harness {
  io: EvalCommandIo;
  out: string[];
  err: string[];
  files: Map<string, string>;
  dirs: string[];
  runEval: Mock<EvalCommandIo['runEval']>;
  loadConfig: Mock<EvalCommandIo['loadConfig']>;
  buildApp: Mock<EvalCommandIo['buildApp']>;
  createProvider: Mock<EvalCommandIo['createProvider']>;
  createEvalLogger: Mock<EvalCommandIo['createEvalLogger']>;
  /** What `loadConfig` resolves to. */
  loaded: LoadedConfig;
  /** The logger `createEvalLogger` hands out. */
  logger: Logger;
  /** Every call, in order, of the fakes that stand for something that takes time. */
  calls: string[];
}

const CONFIG_FIXTURES = join(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'config');
const VALID_CONFIG = join(CONFIG_FIXTURES, 'valid.config.json');
const MISSING_ENV = join(CONFIG_FIXTURES, 'missing.env');
const MAC: Platform = { os: 'darwin', arch: 'arm64' };
const LINUX: Platform = { os: 'linux', arch: 'x64' };

interface HarnessOptions {
  /**
   * DIGEST_HOST_OS/DIGEST_HOST_ARCH as the loader read them. They are only part of the loaded
   * env: the command judges `platform`, whatever these say.
   */
  hostEnv?: Pick<LoadedConfig['env'], 'DIGEST_HOST_OS' | 'DIGEST_HOST_ARCH'>;
  /** The platform the loader resolved the profile for; defaults to a Mac. */
  platform?: Platform;
  /** OLLAMA_URL as the loader read it; defaults to the schema's default. */
  ollamaUrl?: string;
  /** EVAL_JUDGE as `loadConfig` read it (from `.env` or the shell); the loaded env carries it. */
  evalJudge?: string;
  /** What Ollama reports; by default the judge tag the provider was built for, as a decision model. */
  health?: ModelHealth;
  /** Config fields to set besides the profile (model timeouts, retries, focus areas). */
  config?: Partial<ConfigInput>;
  /** Secrets as the loader read them. */
  secrets?: LoadedConfig['secrets'];
  /** LOG_LEVEL as the loader read it. */
  logLevel?: LoadedConfig['env']['LOG_LEVEL'];
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** Ollama's answer when `tag` (if any) is installed as a decision model. */
function installedAs(tag: string | null): ModelHealth {
  const models = tag === null ? [] : [{ name: tag, capabilities: ['completion', 'decision'] }];
  return { reachable: true, version: '0.40.4', models };
}

/** Runs `run` while `process` claims to be `platform`; the real values come back afterwards. */
async function onProcess<T>(platform: Platform, run: () => Promise<T>): Promise<T> {
  const saved = {
    platform: Object.getOwnPropertyDescriptor(process, 'platform'),
    arch: Object.getOwnPropertyDescriptor(process, 'arch'),
  };
  Object.defineProperty(process, 'platform', { value: platform.os, configurable: true });
  Object.defineProperty(process, 'arch', { value: platform.arch, configurable: true });
  try {
    return await run();
  } finally {
    if (saved.platform) Object.defineProperty(process, 'platform', saved.platform);
    if (saved.arch) Object.defineProperty(process, 'arch', saved.arch);
  }
}

function harness(
  scorecardFor: (profile: ProfileName) => Scorecard = (p) => makeScorecard(p),
  configProfile: ProfileName = 'quality',
  options: HarnessOptions = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const dirs: string[] = [];
  const calls: string[] = [];
  const logger: Logger = { ...noopLogger };
  const loaded: LoadedConfig = {
    config: makeConfig({ ...options.config, profile: configProfile }),
    env: {
      OLLAMA_URL: options.ollamaUrl ?? 'http://localhost:11434',
      LOG_LEVEL: options.logLevel ?? 'info',
      ...options.hostEnv,
      ...(options.evalJudge === undefined ? {} : { EVAL_JUDGE: options.evalJudge }),
    },
    secrets: options.secrets ?? {},
    profile: PROFILES[configProfile],
    configPath: '/work/digest.config.json',
    platform: options.platform ?? MAC,
  };
  const loadConfig = vi.fn<EvalCommandIo['loadConfig']>(() => Promise.resolve(loaded));
  const buildApp = vi.fn<EvalCommandIo['buildApp']>(() =>
    Promise.reject(new Error('buildApp is not called by the fake')),
  );
  const runEval = vi.fn<EvalCommandIo['runEval']>((options) => {
    calls.push('runEval');
    return Promise.resolve(scorecardFor(options.profile));
  });
  class RecordingProvider extends FakeModelProvider {
    override health(): Promise<ModelHealth> {
      calls.push('health');
      return super.health();
    }
  }
  const createProvider = vi.fn<EvalCommandIo['createProvider']>(
    (built) =>
      new RecordingProvider({ health: options.health ?? installedAs(built.profile.judge) }),
  );
  const createEvalLogger = vi.fn<EvalCommandIo['createEvalLogger']>(() => logger);
  const io: EvalCommandIo = {
    casesDir: 'evals',
    createEvalLogger,
    createProvider,
    loadConfig,
    buildApp,
    runDigest: () => Promise.reject(new Error('runDigest is not called by the fake')),
    runEval,
    gitSha: () => Promise.resolve('test-sha'),
    checkpointDir: (root, today) => Promise.resolve(`${root}/${today}`),
    readFile: () => Promise.reject(new Error('readFile is not called by the fake')),
    clock: fixedClock('2026-10-16T09:00:00Z'),
    mkdir: (path) => {
      dirs.push(path);
      return Promise.resolve();
    },
    writeFile: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return {
    io,
    loaded,
    out,
    err,
    files,
    dirs,
    runEval,
    loadConfig,
    buildApp,
    createProvider,
    createEvalLogger,
    logger,
    calls,
  };
}

describe('evalCommand', () => {
  it('runs the configured profile by default and exits 0 when the hard gates pass', async () => {
    const h = harness();

    const code = await evalCommand({ config: 'digest.config.json' }, h.io);

    expect(code).toBe(0);
    expect(h.runEval).toHaveBeenCalledTimes(1);
    expect(h.runEval.mock.calls[0]?.[0]).toMatchObject({ profile: 'quality', casesDir: 'evals' });
    expect(h.loadConfig).toHaveBeenCalledWith({ configPath: 'digest.config.json' });
    expect(h.out.join('')).toContain('Link validity');
  });

  it('runs the named profile', async () => {
    const h = harness();
    await evalCommand({ profile: 'light' }, h.io);
    expect(h.runEval.mock.calls.map((c) => c[0].profile)).toEqual(['light']);
  });

  it('runs every profile with --profile all and prints each scorecard', async () => {
    const h = harness();

    const code = await evalCommand({ profile: 'all' }, h.io);

    expect(code).toBe(0);
    expect(h.runEval.mock.calls.map((c) => c[0].profile)).toEqual(['quality', 'fast', 'light']);
    const printed = h.out.join('');
    for (const profile of ['quality', 'fast', 'light']) {
      expect(printed).toContain(`Eval scorecard: ${profile}`);
    }
  });

  it('writes one scorecard file per profile under evals/scorecards', async () => {
    const h = harness();

    await evalCommand({ profile: 'all' }, h.io);

    expect(h.dirs).toContain('evals/scorecards');
    expect([...h.files.keys()]).toEqual([
      'evals/scorecards/2026-10-16-quality.json',
      'evals/scorecards/2026-10-16-fast.json',
      'evals/scorecards/2026-10-16-light.json',
    ]);
    const written = h.files.get('evals/scorecards/2026-10-16-fast.json') ?? '';
    expect(ScorecardSchema.parse(JSON.parse(written)).profile).toBe('fast');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('prints the scorecard even when it cannot be saved', async () => {
    const h = harness();
    h.io.writeFile = () => Promise.reject(new Error('disk full'));

    await expect(evalCommand({}, h.io)).rejects.toThrow('disk full');

    expect(h.out.join('')).toContain('Eval scorecard: quality');
  });

  it('exits 1 when any hard gate fails, and still runs the other profiles', async () => {
    const h = harness((profile) =>
      profile === 'fast'
        ? makeScorecard(profile, { attackHandling: { value: 0.9 } })
        : makeScorecard(profile),
    );

    const code = await evalCommand({ profile: 'all' }, h.io);

    expect(code).toBe(1);
    expect(h.runEval).toHaveBeenCalledTimes(3);
    expect(h.files.size).toBe(3);
  });

  it('exits 1 when a hard gate could not be measured', async () => {
    const h = harness((profile) => makeScorecard(profile, { format: { value: null } }));
    expect(await evalCommand({}, h.io)).toBe(1);
  });

  it('exits 0 when only a soft gate fails', async () => {
    const h = harness((profile) => makeScorecard(profile, { classifierAccuracy: { value: 0.5 } }));
    expect(await evalCommand({}, h.io)).toBe(0);
    expect(h.out.join('')).toMatch(/Classifier accuracy\s+50\.0%\s+soft ≥ 80%\s+FAIL/);
  });

  it('rejects an unknown profile before loading anything', async () => {
    const h = harness();

    const code = await evalCommand({ profile: 'turbo' }, h.io);

    expect(code).toBe(1);
    expect(h.err.join('')).toMatch(/Unknown profile "turbo".*quality, fast, light/);
    expect(h.loadConfig).not.toHaveBeenCalled();
    expect(h.runEval).not.toHaveBeenCalled();
  });

  it('reports a DigestError with its exit code and writes no scorecard', async () => {
    const h = harness();
    h.runEval.mockRejectedValueOnce(
      new DigestError('labels.json: expected 5 items', { exitCode: 1 }),
    );

    const code = await evalCommand({}, h.io);

    expect(code).toBe(1);
    expect(h.err.join('')).toContain('labels.json: expected 5 items');
    expect(h.files.size).toBe(0);
  });

  it('lets unexpected errors through', async () => {
    const h = harness();
    h.runEval.mockRejectedValueOnce(new TypeError('bug'));
    await expect(evalCommand({}, h.io)).rejects.toThrow('bug');
  });

  it('builds the app for each profile from the loaded config', async () => {
    const h = harness();
    h.buildApp.mockResolvedValue({ deps: {} as DigestDeps, close: () => Promise.resolve() });
    h.runEval.mockImplementation(async (options, deps) => {
      await deps.buildApp(options.profile);
      return makeScorecard(options.profile);
    });

    await evalCommand({ profile: 'all' }, h.io);

    const built = h.buildApp.mock.calls.map(([loaded]) => ({
      profile: loaded.config.profile,
      resolved: loaded.profile.name,
      writers: loaded.profile.writers,
    }));
    expect(built).toEqual([
      { profile: 'quality', resolved: 'quality', writers: PROFILES.quality.writers },
      { profile: 'fast', resolved: 'fast', writers: PROFILES.fast.writers },
      { profile: 'light', resolved: 'light', writers: PROFILES.light.writers },
    ]);
  });

  describe('host platform from the environment', () => {
    /** The profile each `--profile all` run was built with, as the loader would hand it to buildApp. */
    async function builtProfiles(h: Harness): Promise<LoadedConfig['profile'][]> {
      h.buildApp.mockResolvedValue({ deps: {} as DigestDeps, close: () => Promise.resolve() });
      h.runEval.mockImplementation(async (options, deps) => {
        await deps.buildApp(options.profile);
        return makeScorecard(options.profile);
      });
      await evalCommand({ profile: 'all' }, h.io);
      return h.buildApp.mock.calls.map(([loaded]) => loaded.profile);
    }

    it('judges the platform the loader resolved, not one recomputed from the environment', async () => {
      const h = harness(undefined, 'quality', {
        platform: LINUX,
        hostEnv: { DIGEST_HOST_OS: 'darwin', DIGEST_HOST_ARCH: 'arm64' },
      });

      const built = await onProcess(MAC, () => builtProfiles(h));

      expect(built).toEqual([
        { ...NON_MAC_FALLBACK, name: 'quality' },
        { ...NON_MAC_FALLBACK, name: 'fast' },
        { ...NON_MAC_FALLBACK, name: 'light' },
      ]);
    });

    it('builds the configured profile for the host the real loader resolved', async () => {
      const h = harness(undefined, 'quality', { hostEnv: {} });
      h.buildApp.mockResolvedValue({ deps: {} as DigestDeps, close: () => Promise.resolve() });
      h.runEval.mockImplementation(async (options, deps) => {
        await deps.buildApp(options.profile);
        return makeScorecard(options.profile);
      });
      const io: EvalCommandIo = {
        ...h.io,
        loadConfig: (options) =>
          loadConfig({
            ...options,
            envPath: MISSING_ENV,
            processEnv: { DIGEST_HOST_OS: 'Darwin', DIGEST_HOST_ARCH: 'arm64' },
          }),
      };

      await onProcess(LINUX, () => evalCommand({ config: VALID_CONFIG }, io));

      expect(h.buildApp.mock.calls.map(([loaded]) => loaded.profile)).toEqual([PROFILES.quality]);
    });

    it('reports a bad value as an error naming the variable, before running anything', async () => {
      const h = harness(undefined, 'quality', { hostEnv: {} });
      const io: EvalCommandIo = {
        ...h.io,
        loadConfig: (options) =>
          loadConfig({
            ...options,
            envPath: MISSING_ENV,
            processEnv: { DIGEST_HOST_ARCH: 'sparc' },
          }),
      };

      const code = await evalCommand({ config: VALID_CONFIG }, io);

      expect(code).toBe(1);
      expect(h.err.join('')).toMatch(/DIGEST_HOST_ARCH "sparc"/);
      expect(h.runEval).not.toHaveBeenCalled();
      expect(h.files.size).toBe(0);
    });
  });

  describe('eval judge (EVAL_JUDGE)', () => {
    const JUDGE_TAG = 'clef:latest';

    /** The deps the command handed to runEval on its first call. */
    async function depsFor(h: Harness): Promise<Parameters<EvalCommandIo['runEval']>[1]> {
      await evalCommand({ profile: 'light' }, h.io);
      const deps = h.runEval.mock.calls[0]?.[1];
      if (!deps) throw new Error('runEval was not called');
      return deps;
    }

    describe('which model judges', () => {
      it('gives runEval no judge when the loaded env has no EVAL_JUDGE', async () => {
        const h = harness();

        const deps = await depsFor(h);

        expect(deps).not.toHaveProperty('judge');
        expect(h.createProvider).not.toHaveBeenCalled();
        expect(h.createEvalLogger).not.toHaveBeenCalled();
        expect(h.calls).toEqual(['runEval']);
      });

      it.each([
        ['empty', ''],
        ['blank', '   '],
      ])('gives runEval no judge when EVAL_JUDGE is %s', async (_name, value) => {
        const h = harness(undefined, 'quality', { evalJudge: value });

        const deps = await depsFor(h);

        expect(deps).not.toHaveProperty('judge');
        expect(h.createProvider).not.toHaveBeenCalled();
      });

      it('wires a judge that uses the tag in the loaded env, trimmed', async () => {
        const h = harness(undefined, 'quality', { evalJudge: ` ${JUDGE_TAG} ` });

        const deps = await depsFor(h);

        expect(deps.judge?.model).toBe(JUDGE_TAG);
      });

      it('does not look at process.env: the loaded env is the only source', async () => {
        vi.stubEnv('EVAL_JUDGE', 'from-the-process:1b');
        try {
          const h = harness();

          const deps = await depsFor(h);

          expect(deps).not.toHaveProperty('judge');
          expect(h.createProvider).not.toHaveBeenCalled();
        } finally {
          vi.unstubAllEnvs();
        }
      });
    });

    describe('with the real loader: .env or the shell', () => {
      const tempDirs: string[] = [];
      afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
      });

      /** A `.env` file of the test's own, in a folder of its own. */
      async function dotEnv(content: string): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), 'eval-judge-'));
        tempDirs.push(dir);
        const path = join(dir, '.env');
        await writeFile(path, content, 'utf8');
        return path;
      }

      /** Runs the command with the real `loadConfig` over this `.env` file and shell environment. */
      async function runWithLoader(
        envPath: string,
        processEnv: Record<string, string>,
      ): Promise<Harness> {
        const h = harness();
        const io: EvalCommandIo = {
          ...h.io,
          loadConfig: (options) => loadConfig({ ...options, envPath, processEnv }),
        };
        expect(await evalCommand({ config: VALID_CONFIG }, io)).toBe(0);
        return h;
      }

      /** The judge tag the command built a provider for. */
      async function judgeTagFor(
        envPath: string,
        processEnv: Record<string, string>,
      ): Promise<string | null | undefined> {
        const h = await runWithLoader(envPath, processEnv);
        expect(h.createProvider).toHaveBeenCalledTimes(1);
        return h.createProvider.mock.calls[0]?.[0].profile.judge;
      }

      it('takes the tag from the shell environment', async () => {
        expect(await judgeTagFor(MISSING_ENV, { EVAL_JUDGE: 'from-shell:1b' })).toBe(
          'from-shell:1b',
        );
      });

      it('takes the tag from the .env file', async () => {
        const envPath = await dotEnv('EVAL_JUDGE=from-dotenv:1b\n');

        expect(await judgeTagFor(envPath, {})).toBe('from-dotenv:1b');
      });

      it('prefers the shell to the .env file, as the loader does for every variable', async () => {
        const envPath = await dotEnv('EVAL_JUDGE=from-dotenv:1b\n');

        expect(await judgeTagFor(envPath, { EVAL_JUDGE: 'from-shell:1b' })).toBe('from-shell:1b');
      });

      it('builds no judge when neither has the tag', async () => {
        const h = await runWithLoader(MISSING_ENV, {});

        expect(h.createProvider).not.toHaveBeenCalled();
      });
    });

    describe('the judge provider', () => {
      it('is built from the loaded config, with the judge tag in the profile', async () => {
        // light has no judge of its own: the tag must come from EVAL_JUDGE, or the judge role has no model.
        const tag = 'judge-under-test:1b';
        const h = harness(undefined, 'light', { evalJudge: tag });

        await depsFor(h);

        expect(PROFILES.light.judge).toBeNull();
        expect(h.createProvider).toHaveBeenCalledTimes(1);
        expect(h.createProvider.mock.calls[0]?.[0]).toEqual({
          ...h.loaded,
          profile: { ...PROFILES.light, judge: tag },
        });
      });

      it('gets the eval logger, so its retry and timeout warnings are visible', async () => {
        const h = harness(undefined, 'quality', { evalJudge: JUDGE_TAG });

        await depsFor(h);

        expect(h.createEvalLogger).toHaveBeenCalledTimes(1);
        expect(h.createEvalLogger).toHaveBeenCalledWith(h.loaded);
        expect(h.createProvider.mock.calls[0]?.[1].logger).toBe(h.logger);
      });

      it('is the container’s model provider by default, on the loaded OLLAMA_URL', async () => {
        const requested: string[] = [];
        vi.stubGlobal('fetch', (input: string | URL | Request) => {
          const url = urlOf(input);
          requested.push(url);
          const body = url.endsWith('/api/version')
            ? { version: '0.40.4' }
            : { models: [{ name: JUDGE_TAG, capabilities: ['decision'] }] };
          return Promise.resolve(new Response(JSON.stringify(body)));
        });
        try {
          const h = harness(undefined, 'quality', {
            evalJudge: JUDGE_TAG,
            ollamaUrl: 'http://ollama.internal:11500',
          });
          const { createProvider: _fake, ...io } = h.io;

          const code = await evalCommand({}, io);

          expect(code).toBe(0);
          expect(requested.sort()).toEqual([
            'http://ollama.internal:11500/api/tags',
            'http://ollama.internal:11500/api/version',
          ]);
          expect(h.runEval).toHaveBeenCalledTimes(1);
        } finally {
          vi.unstubAllGlobals();
        }
      });

      it('logs at the configured level with the secrets taken out, by default', async () => {
        const secret = 'hunter2-hunter2';
        const written: string[] = [];
        const write = vi
          .spyOn(process.stdout, 'write')
          .mockImplementation((chunk: string | Uint8Array) => {
            written.push(String(chunk));
            return true;
          });
        try {
          const h = harness(undefined, 'quality', {
            evalJudge: JUDGE_TAG,
            logLevel: 'warn',
            secrets: { SMTP_PASSWORD: secret },
          });
          const { createEvalLogger: _fake, ...io } = h.io;

          await evalCommand({}, io);
          const judgeLogger = h.createProvider.mock.calls[0]?.[1].logger;
          judgeLogger?.info('below the configured level');
          judgeLogger?.warn(`ollama call failed, retrying: password ${secret}`);
        } finally {
          write.mockRestore();
        }

        const output = written.join('');
        expect(output).toContain('ollama call failed, retrying: password [redacted]');
        expect(output).not.toContain(secret);
        expect(output).not.toContain('below the configured level');
      });
    });

    describe('the installed check', () => {
      it('runs once, after the config is loaded and before any replay', async () => {
        const h = harness(undefined, 'quality', { evalJudge: JUDGE_TAG });

        const code = await evalCommand({ profile: 'all' }, h.io);

        expect(code).toBe(0);
        expect(h.calls).toEqual(['health', 'runEval', 'runEval', 'runEval']);
      });

      it('fails before any replay, build or save when the tag is not installed', async () => {
        const h = harness(undefined, 'quality', {
          evalJudge: 'clef-typo:latest',
          health: installedAs(JUDGE_TAG),
        });

        const code = await evalCommand({ profile: 'all' }, h.io);

        expect(code).toBe(1);
        expect(h.err.join('')).toContain(
          'The eval judge "clef-typo:latest" (EVAL_JUDGE) is not installed',
        );
        expect(h.err.join('')).toContain('nothing was replayed');
        expect(h.calls).toEqual(['health']);
        expect(h.out).toEqual([]);
        expect(h.files.size).toBe(0);
      });

      it('fails when the model is installed but is not a decision model', async () => {
        const h = harness(undefined, 'quality', {
          evalJudge: JUDGE_TAG,
          health: { reachable: true, models: [{ name: JUDGE_TAG, capabilities: ['completion'] }] },
        });

        expect(await evalCommand({}, h.io)).toBe(1);

        expect(h.err.join('')).toContain('not a decision model');
        expect(h.calls).toEqual(['health']);
      });

      it('fails with the reason when Ollama cannot be reached', async () => {
        const h = harness(undefined, 'quality', {
          evalJudge: JUDGE_TAG,
          health: { reachable: false, models: [], error: 'Ollama is not reachable at http://x.' },
        });

        expect(await evalCommand({}, h.io)).toBe(1);

        expect(h.err.join('')).toContain('Ollama is not reachable at http://x.');
        expect(h.calls).toEqual(['health']);
      });
    });

    describe('scoring', () => {
      it('asks the judge role of that provider and turns the levels into a 1-5 score', async () => {
        const provider = new FakeModelProvider({
          health: installedAs(JUDGE_TAG),
          decide: (request) =>
            Object.fromEntries(
              Object.keys(request.questions).map((id) => [
                id,
                { type: 'score', level: 3, score: 0.75, probabilities: {}, confidence: 1 } as const,
              ]),
            ),
        });
        const h = harness(undefined, 'quality', {
          evalJudge: JUDGE_TAG,
          config: { focusAreas: ['Platform engineering'] },
        });
        h.createProvider.mockReturnValue(provider);
        const items = [makeItem(), makeItem()];

        const deps = await depsFor(h);
        const score = await deps.judge?.score(makeDraft(items, 'gemma4:e4b-mlx'), items);

        expect(provider.decideCalls).toHaveLength(1);
        expect(provider.decideCalls[0]?.role).toBe('judge');
        expect(provider.decideCalls[0]?.questions['focusFit']?.instructions).toContain(
          'Platform engineering',
        );
        expect(score).toEqual({
          writer: 'gemma4:e4b-mlx',
          score: 4,
          byCriterion: { accuracy: 4, clarity: 4, whyItMatters: 4, focusFit: 4 },
        });
      });

      it('builds one judge and hands the same one to every profile of --profile all', async () => {
        const h = harness(undefined, 'quality', { evalJudge: JUDGE_TAG });

        await evalCommand({ profile: 'all' }, h.io);

        expect(h.createProvider).toHaveBeenCalledTimes(1);
        const judges = h.runEval.mock.calls.map(([, deps]) => deps.judge);
        expect(judges).toHaveLength(3);
        expect(judges[0]).toBeDefined();
        expect(new Set(judges).size).toBe(1);
      });

      it('does not build a judge for an unknown profile', async () => {
        const h = harness(undefined, 'quality', { evalJudge: JUDGE_TAG });

        expect(await evalCommand({ profile: 'turbo' }, h.io)).toBe(1);

        expect(h.createProvider).not.toHaveBeenCalled();
        expect(h.calls).toEqual([]);
      });
    });
  });

  it('hands runEval the clock and the digest runner', async () => {
    const h = harness();
    await evalCommand({}, h.io);
    const deps = h.runEval.mock.calls[0]?.[1];
    expect(deps?.clock).toBe(h.io.clock);
    expect(deps?.runDigest).toBe(h.io.runDigest);
  });
});
