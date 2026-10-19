// prepareEvalJudge: the judge for a profile without one, from the EVAL_JUDGE environment variable
// (not the EVAL_JUDGE model-tag constant of config/profiles). No model is called: the provider is a fake.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type LoadedConfig } from '../../../config/load';
import { EVAL_JUDGE, PROFILES } from '../../../config/profiles';
import type { ConfigInput, ProfileName } from '../../../config/schema';
import type { ModelHealth } from '../../../models/ModelProvider';
import { DigestError } from '../../../shared/errors';
import type { Logger } from '../../../shared/telemetry';
import { makeConfig, makeDraft, makeItem } from '../../../../test/builders';
import { FakeModelProvider, noopLogger } from '../../../../test/fakes';
import type { FakeModelProviderOptions } from '../../../../test/fakes/FakeModelProvider';
import { prepareEvalJudge, type JudgeSetupIo } from './prepareEvalJudge';

const JUDGE_TAG = 'clef:latest';
const CONFIG_FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'config',
);
const VALID_CONFIG = join(CONFIG_FIXTURES, 'valid.config.json');
const MISSING_ENV = join(CONFIG_FIXTURES, 'missing.env');

/** Ollama's answer when `tag` is installed as a decision model. */
function installedAs(tag: string): ModelHealth {
  return {
    reachable: true,
    version: '0.40.4',
    models: [{ name: tag, capabilities: ['completion', 'decision'] }],
  };
}

function loadedWith(
  evalJudge: string | undefined,
  profile: ProfileName = 'quality',
  config: Partial<ConfigInput> = {},
): LoadedConfig {
  return {
    config: makeConfig({ ...config, profile }),
    env: {
      OLLAMA_URL: 'http://localhost:11434',
      LOG_LEVEL: 'info',
      ...(evalJudge === undefined ? {} : { EVAL_JUDGE: evalJudge }),
    },
    secrets: {},
    profile: PROFILES[profile],
    configPath: '/work/digest.config.json',
    platform: { os: 'darwin', arch: 'arm64' },
  };
}

/** A fake that counts how often Ollama is asked what is installed. */
class RecordingProvider extends FakeModelProvider {
  constructor(
    private readonly healthCalls: string[],
    options: FakeModelProviderOptions,
  ) {
    super(options);
  }

  override health(): Promise<ModelHealth> {
    this.healthCalls.push('health');
    return super.health();
  }
}

/** `options` script the provider; by default it reports the judge tag it was built for as installed. */
function setup(options?: FakeModelProviderOptions) {
  const logger: Logger = { ...noopLogger };
  const healthCalls: string[] = [];
  const providers: RecordingProvider[] = [];
  const createProvider = vi.fn<JudgeSetupIo['createProvider']>((built) => {
    const provider = new RecordingProvider(
      healthCalls,
      options ?? { health: installedAs(built.profile.judge ?? JUDGE_TAG) },
    );
    providers.push(provider);
    return provider;
  });
  const createEvalLogger = vi.fn<JudgeSetupIo['createEvalLogger']>(() => logger);
  const io: JudgeSetupIo = { createProvider, createEvalLogger };
  return { io, createProvider, createEvalLogger, logger, healthCalls, providers };
}

describe('prepareEvalJudge: which model judges', () => {
  it('builds no judge, provider or logger when the environment has no EVAL_JUDGE', async () => {
    const t = setup();

    await expect(prepareEvalJudge(loadedWith(undefined), t.io)).resolves.toBeUndefined();

    expect(t.createProvider).not.toHaveBeenCalled();
    expect(t.createEvalLogger).not.toHaveBeenCalled();
    expect(t.healthCalls).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('builds no judge when EVAL_JUDGE is %s', async (_name, value) => {
    const t = setup();

    await expect(prepareEvalJudge(loadedWith(value), t.io)).resolves.toBeUndefined();

    expect(t.createProvider).not.toHaveBeenCalled();
  });

  it('uses the tag in the loaded environment, trimmed', async () => {
    const judge = await prepareEvalJudge(loadedWith(` ${JUDGE_TAG} `), setup().io);

    expect(judge?.model).toBe(JUDGE_TAG);
  });

  it('does not look at process.env: the loaded environment is the only source', async () => {
    vi.stubEnv('EVAL_JUDGE', 'from-the-process:1b');
    try {
      const t = setup();

      await expect(prepareEvalJudge(loadedWith(undefined), t.io)).resolves.toBeUndefined();

      expect(t.createProvider).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ignores the EVAL_JUDGE constant of config/profiles that a writers override puts in the profile', async () => {
    const t = setup();
    const loaded = loadedWith(undefined, 'light');
    const withOverrideJudge: LoadedConfig = {
      ...loaded,
      profile: { ...loaded.profile, judge: EVAL_JUDGE },
    };

    await expect(prepareEvalJudge(withOverrideJudge, t.io)).resolves.toBeUndefined();

    expect(t.createProvider).not.toHaveBeenCalled();
  });
});

describe('prepareEvalJudge: with the real loader, .env or the shell', () => {
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

  /** The tag of the judge built over what the real `loadConfig` read; undefined when none is built. */
  async function judgeTagFor(
    envPath: string,
    processEnv: Record<string, string>,
  ): Promise<string | undefined> {
    const loaded = await loadConfig({ configPath: VALID_CONFIG, envPath, processEnv });
    const t = setup();
    const judge = await prepareEvalJudge(loaded, t.io);
    expect(t.createProvider).toHaveBeenCalledTimes(judge === undefined ? 0 : 1);
    return t.createProvider.mock.calls[0]?.[0].profile.judge ?? undefined;
  }

  it('takes the tag from the shell environment', async () => {
    expect(await judgeTagFor(MISSING_ENV, { EVAL_JUDGE: 'from-shell:1b' })).toBe('from-shell:1b');
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
    expect(await judgeTagFor(MISSING_ENV, {})).toBeUndefined();
  });
});

describe('prepareEvalJudge: the judge provider', () => {
  it('is built from the loaded config, with the judge tag in the profile', async () => {
    // light has no judge of its own: the tag must come from EVAL_JUDGE, or the judge role has no model.
    const tag = 'judge-under-test:1b';
    const loaded = loadedWith(tag, 'light');
    const t = setup();

    await prepareEvalJudge(loaded, t.io);

    expect(PROFILES.light.judge).toBeNull();
    expect(t.createProvider).toHaveBeenCalledTimes(1);
    expect(t.createProvider.mock.calls[0]?.[0]).toEqual({
      ...loaded,
      profile: { ...PROFILES.light, judge: tag },
    });
  });

  it('leaves the loaded config as it was', async () => {
    const loaded = loadedWith(JUDGE_TAG, 'light');
    const before = structuredClone(loaded);

    await prepareEvalJudge(loaded, setup().io);

    expect(loaded).toEqual(before);
  });

  it('gets the eval logger of the loaded config, so retry and timeout warnings are visible', async () => {
    const loaded = loadedWith(JUDGE_TAG);
    const t = setup();

    await prepareEvalJudge(loaded, t.io);

    expect(t.createEvalLogger).toHaveBeenCalledTimes(1);
    expect(t.createEvalLogger).toHaveBeenCalledWith(loaded);
    expect(t.createProvider.mock.calls[0]?.[1].logger).toBe(t.logger);
  });
});

describe('prepareEvalJudge: the installed check', () => {
  it('asks Ollama once, and returns the judge when the tag is a decision model', async () => {
    const t = setup();

    const judge = await prepareEvalJudge(loadedWith(JUDGE_TAG), t.io);

    expect(judge).toBeDefined();
    expect(t.healthCalls).toEqual(['health']);
  });

  it('throws a DigestError that names EVAL_JUDGE when the tag is not installed', async () => {
    const t = setup({ health: installedAs(JUDGE_TAG) });

    const failure = prepareEvalJudge(loadedWith('clef-typo:latest'), t.io);

    await expect(failure).rejects.toBeInstanceOf(DigestError);
    await expect(failure).rejects.toThrow(
      'The eval judge "clef-typo:latest" (EVAL_JUDGE) is not installed',
    );
  });

  it('throws when the model is installed but is not a decision model', async () => {
    const t = setup({
      health: { reachable: true, models: [{ name: JUDGE_TAG, capabilities: ['completion'] }] },
    });

    await expect(prepareEvalJudge(loadedWith(JUDGE_TAG), t.io)).rejects.toThrow(
      'not a decision model',
    );
  });

  it('throws with the reason when Ollama cannot be reached', async () => {
    const t = setup({
      health: { reachable: false, models: [], error: 'Ollama is not reachable at http://x.' },
    });

    await expect(prepareEvalJudge(loadedWith(JUDGE_TAG), t.io)).rejects.toThrow(
      'Ollama is not reachable at http://x.',
    );
  });
});

describe('prepareEvalJudge: scoring', () => {
  it('asks the judge role of that provider and turns the levels into a 1-5 score', async () => {
    const t = setup({
      health: installedAs(JUDGE_TAG),
      decide: (request) =>
        Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: 'score', level: 3, score: 0.75, probabilities: {}, confidence: 1 } as const,
          ]),
        ),
    });
    const items = [makeItem(), makeItem()];

    const judge = await prepareEvalJudge(
      loadedWith(JUDGE_TAG, 'quality', { focusAreas: ['Platform engineering'] }),
      t.io,
    );
    const score = await judge?.score(makeDraft(items, 'gemma4:e4b-mlx'), items);

    const decideCalls = t.providers[0]?.decideCalls ?? [];
    expect(decideCalls).toHaveLength(1);
    expect(decideCalls[0]?.role).toBe('judge');
    expect(decideCalls[0]?.questions['focusFit']?.instructions).toContain('Platform engineering');
    expect(score).toEqual({
      writer: 'gemma4:e4b-mlx',
      score: 4,
      byCriterion: { accuracy: 4, clarity: 4, whyItMatters: 4, focusFit: 4 },
    });
  });
});
