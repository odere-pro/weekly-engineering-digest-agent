import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppHandle } from '../../../src/app/container';
import { loadConfig, type LoadedConfig } from '../../../src/config/load';
import type { Platform } from '../../../src/config/profiles';
import type { Calibration } from '../../../src/process/calibration';
import { systemClock } from '../../../src/shared/clock';
import { makeConfig } from '../../../test/builders';
import { FakeModelProvider, noopLogger } from '../../../test/fakes';
import { cases } from '../__fixtures__/rescoreKit';
import { replayRescore } from '../replay/replayRescore';
import type { RescoreResult } from '../replay/types';
import { runWithApp } from './runWithApp';

// The real loader reads digest.config.json and .env, the real app starts Ollama clients and the
// real replay calls the models: all three are replaced, so this test touches no file or model.
vi.mock('../../../src/config/load', () => ({
  loadConfig: vi.fn(),
  platformOf: (loaded: { platform: unknown }) => loaded.platform,
}));
vi.mock('../../../src/app/container', () => ({ buildApp: vi.fn() }));
vi.mock('../replay/replayRescore', () => ({ replayRescore: vi.fn() }));

const result: RescoreResult = {
  rescoreWithWriter: false,
  weeks: 1,
  mustIncludeRecall: 1,
  mustExcludeLeaks: 0,
  classifierAccuracy: 0.5,
  secondsPerWeek: 1,
};

const fakeModel = new FakeModelProvider({});

function setup(platform: Platform = { os: 'darwin', arch: 'arm64' }) {
  const close = vi.fn().mockResolvedValue(undefined);
  const app = { deps: { model: fakeModel, logger: noopLogger }, close } as unknown as AppHandle;
  const loaded = {
    config: makeConfig({ profile: 'quality' }),
    platform,
  } as unknown as LoadedConfig;
  vi.mocked(loadConfig).mockResolvedValue(loaded);
  vi.mocked(buildApp).mockResolvedValue(app);
  vi.mocked(replayRescore).mockResolvedValue(result);
  return { close, loaded };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('runWithApp', () => {
  it('replays the cases with the real app model and the profile that was asked for', async () => {
    const { close, loaded } = setup();
    const set = cases();

    const out = await runWithApp({ profile: 'light', config: 'my.json' }, set, true);

    expect(out).toBe(result);
    expect(loadConfig).toHaveBeenCalledWith({ configPath: 'my.json' });
    const built = vi.mocked(buildApp).mock.calls[0]?.[0];
    expect(built?.config).toEqual({ ...loaded.config, profile: 'light' });
    expect(built?.profile.name).toBe('light');
    const [replayCases, replayDeps, rescore] = vi.mocked(replayRescore).mock.calls[0] ?? [];
    expect(replayCases).toBe(set);
    expect(rescore).toBe(true);
    expect(replayDeps).toMatchObject({
      model: fakeModel,
      logger: noopLogger,
      clock: systemClock,
      config: { profile: 'light' },
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('passes the calibration and the pairwise flag through', async () => {
    setup();
    const calibration: Calibration = {
      version: 1,
      profile: 'light',
      points: [{ raw: 2, calibrated: 2 }],
      areaBias: {},
    };

    await runWithApp(
      { profile: 'light', config: undefined, calibration, pairwise: true },
      cases(),
      false,
    );

    expect(vi.mocked(replayRescore).mock.calls[0]?.[1]).toMatchObject({
      calibration,
      pairwise: true,
    });
  });

  it('resolves the profile for the machine: the fallback models off Apple silicon', async () => {
    setup({ os: 'linux', arch: 'x64' });

    await runWithApp({ profile: 'light', config: undefined }, cases(), false);

    const profile = vi.mocked(buildApp).mock.calls[0]?.[0].profile;
    expect(profile).toMatchObject({ name: 'light', requiresAppleSilicon: false });
  });

  it('closes the app and passes the error on when the replay fails', async () => {
    const { close } = setup();
    vi.mocked(replayRescore).mockRejectedValue(new Error('ollama down'));

    await expect(
      runWithApp({ profile: 'light', config: undefined }, cases(), false),
    ).rejects.toThrow('ollama down');

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('starts no app when the config does not load', async () => {
    setup();
    vi.mocked(loadConfig).mockRejectedValue(new Error('no config file'));

    await expect(
      runWithApp({ profile: 'light', config: undefined }, cases(), false),
    ).rejects.toThrow('no config file');

    expect(buildApp).not.toHaveBeenCalled();
  });
});
