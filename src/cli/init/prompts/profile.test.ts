import { describe, expect, it } from 'vitest';
import type { ProfileName } from '../../../config/schema';
import { GIB, harness, type HarnessOptions } from '../__fixtures__/initHarness';
import type { Host } from '../types';
import {
  askProfile,
  PROFILE_DESCRIPTIONS,
  QUALITY_UNMEASURED,
  qualityMemoryWarning,
} from './profile';

type AskOptions = HarnessOptions & { hostOs?: string };

/** Runs the profile question on a fake machine and returns what the user was shown and chose. */
async function ask(options: AskOptions = {}, recommended: ProfileName = 'light') {
  const h = harness(options);
  const host: Host = { inDocker: options.inDocker ?? false, hostOs: options.hostOs };
  const chosen = await askProfile(h.io, host, recommended);
  const call = h.calls.find((c) => c.kind === 'select');
  return { call, chosen };
}

const descriptionOf = async (options: AskOptions, profile = 'quality'): Promise<string> => {
  const { call } = await ask(options);
  const description = call?.options.choices?.find((c) => c.value === profile)?.description;
  if (description === undefined) throw new Error(`the question has no description for ${profile}`);
  return description;
};

describe('askProfile', () => {
  it.each([64, 32, 16])(
    'offers light as the recommended default, whatever the RAM (%i GiB)',
    async (ramGiB) => {
      const { call, chosen } = await ask({ ramGiB });

      expect(call?.options.default).toBe('light');
      expect(call?.options.choices?.map((c) => c.value)).toEqual(['quality', 'fast', 'light']);
      const recommended = call?.options.choices?.filter((c) => c.name.includes('recommended'));
      expect(recommended?.map((c) => c.value)).toEqual(['light']);
      expect(chosen).toBe('light');
    },
  );

  it('marks whichever profile it is told to recommend', async () => {
    const { call, chosen } = await ask({}, 'fast');

    expect(call?.options.default).toBe('fast');
    expect(call?.options.choices?.find((c) => c.value === 'fast')?.name).toBe('fast (recommended)');
    expect(call?.options.choices?.find((c) => c.value === 'light')?.name).toBe('light');
    expect(chosen).toBe('fast');
  });

  it('returns the profile that was chosen', async () => {
    const { chosen } = await ask({ rules: [[/Model profile/, 'quality']] });

    expect(chosen).toBe('quality');
  });

  it('describes every profile', async () => {
    const { call } = await ask();

    for (const choice of call?.options.choices ?? []) {
      expect(choice.description).toContain(PROFILE_DESCRIPTIONS[choice.value as ProfileName]);
    }
  });
});

describe('what the profile question says about quality', () => {
  it('says it is not measured yet and took about 1 h per run on the reference laptop', async () => {
    const text = await descriptionOf({ ramGiB: 64 });

    expect(text).toContain(QUALITY_UNMEASURED);
    expect(text).toMatch(/not measured yet/);
    expect(text).toMatch(/about 1 h/);
    expect(text).toMatch(/reference laptop/);
    expect(text).toMatch(/32 GB/);
  });

  it('does not mention memory when the machine has enough', async () => {
    expect(await descriptionOf({ ramGiB: 32 })).not.toMatch(/GiB/);
    expect(await descriptionOf({ ramGiB: 31 })).not.toMatch(/GiB/);
  });

  it('allows 5% under 32 GiB, so a "32 GB" Linux box that reports 31 GiB is not warned', async () => {
    expect(await descriptionOf({ ramGiB: 30.5 })).not.toMatch(/GiB/);
    expect(await descriptionOf({ ramGiB: 30 })).toMatch(/This machine has 30\.0 GiB of RAM/);
  });

  it('warns with the amount the machine has', async () => {
    const text = await descriptionOf({ ramGiB: 24 });

    expect(text).toMatch(/This machine has 24\.0 GiB of RAM; quality needs about 32 GB\./);
  });

  it('names the container limit inside Docker', async () => {
    const text = await descriptionOf({ inDocker: true, ramGiB: 64, memoryLimitGiB: 8 });

    expect(text).toMatch(/Docker limits this container to 8\.0 GiB \(the container limit\)/);
  });

  it('takes the smaller of the container limit and the memory it sees', async () => {
    const text = await descriptionOf({ inDocker: true, ramGiB: 16, memoryLimitGiB: 64 });

    expect(text).toMatch(/Docker shows this container 16\.0 GiB of RAM/);
    expect(text).not.toMatch(/container limit/);
  });

  it('says what Docker shows when the container has no limit', async () => {
    const text = await descriptionOf({ inDocker: true, ramGiB: 12 });

    expect(text).toMatch(/Docker shows this container 12\.0 GiB of RAM; quality needs about 32 GB/);
    expect(text).toMatch(/Ollama may run elsewhere/);
  });

  it('does not warn inside Docker when the limit is enough', async () => {
    const text = await descriptionOf({ inDocker: true, ramGiB: 64, memoryLimitGiB: 48 });

    expect(text).not.toMatch(/GiB/);
  });

  it('keeps the memory warning off the other profiles', async () => {
    expect(await descriptionOf({ ramGiB: 8 }, 'light')).not.toMatch(/GiB/);
    expect(await descriptionOf({ ramGiB: 8 }, 'fast')).not.toMatch(/GiB/);
  });
});

describe('what the profile question says about light', () => {
  const lightOn = (options: AskOptions): Promise<string> => descriptionOf(options, 'light');

  it('promises 16 GB on a Mac', async () => {
    const text = await lightOn({ platform: 'darwin' });

    expect(text).toMatch(/Fits in 16 GB/);
    expect(text).not.toMatch(/fallback/);
  });

  it.each(['linux', 'win32'] as const)(
    'says on %s that it falls back to larger models that need far more than 16 GB',
    async (platform) => {
      const text = await lightOn({ platform });

      expect(text).toMatch(/larger fallback models.*much more than 16 GB/);
      expect(text).toMatch(/digest doctor/);
    },
  );

  it('judges the Mac that runs Ollama, not the Linux container, when Docker names its host', async () => {
    const named = await lightOn({ inDocker: true, platform: 'linux', hostOs: 'darwin' });
    const unnamed = await lightOn({ inDocker: true, platform: 'linux' });

    expect(named).not.toMatch(/fallback/);
    expect(unnamed).toMatch(/larger fallback models/);
  });

  it('trusts the named host over the platform it runs on', async () => {
    const text = await lightOn({ inDocker: true, platform: 'darwin', hostOs: 'linux' });

    expect(text).toMatch(/larger fallback models/);
  });
});

describe('qualityMemoryWarning', () => {
  const warn = (options: HarnessOptions, inDocker = options.inDocker ?? false) =>
    qualityMemoryWarning(harness(options).io, inDocker);

  it.each([
    [64, true],
    [32, true],
    [31.3, true],
    [30.4, true],
    [30.3, false],
    [24, false],
    [16, false],
  ])('%d GiB of RAM: enough is %s', (ramGiB, enough) => {
    expect(warn({ ramGiB }) === undefined).toBe(enough);
  });

  it('allows 5% under 32 GiB, for the memory a kernel keeps for itself', () => {
    const at = qualityMemoryWarning({ ...harness().io, totalMemoryBytes: 32 * GIB * 0.95 }, false);
    const below = qualityMemoryWarning(
      { ...harness().io, totalMemoryBytes: 32 * GIB * 0.95 - 1 },
      false,
    );

    expect(at).toBeUndefined();
    expect(below).toBeDefined();
  });

  it('names the amount the machine has outside Docker', () => {
    expect(warn({ ramGiB: 24 })).toBe(
      'This machine has 24.0 GiB of RAM; quality needs about 32 GB.',
    );
  });

  it('names the container limit when it is the smaller figure', () => {
    expect(warn({ inDocker: true, ramGiB: 64, memoryLimitGiB: 8 })).toBe(
      'Docker limits this container to 8.0 GiB (the container limit); quality needs about 32 GB.',
    );
  });

  it('ignores a limit above the memory the container sees', () => {
    expect(warn({ inDocker: true, ramGiB: 16, memoryLimitGiB: 64 })).toBe(
      'Docker shows this container 16.0 GiB of RAM; quality needs about 32 GB. Ollama may run elsewhere with more.',
    );
  });

  it('treats a limit of 0 as no limit', () => {
    expect(warn({ inDocker: true, ramGiB: 12, memoryLimitGiB: 0 })).toMatch(
      /^Docker shows this container 12\.0 GiB of RAM/,
    );
  });

  it('treats an unset limit as no limit', () => {
    const { memoryLimitBytes: _unset, ...io } = harness({ ramGiB: 12 }).io;

    expect(qualityMemoryWarning(io, true)).toMatch(/^Docker shows this container 12\.0 GiB/);
  });
});
