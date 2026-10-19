import { describe, expect, it } from 'vitest';
import type { ProfileName } from '../../../config/schema';
import { GIB, harness, type HarnessOptions } from '../__fixtures__/initHarness';
import type { Host } from '../types';
import {
  askProfile,
  PROFILE_DESCRIPTIONS,
  QUALITY_TIGHT_RAM,
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
  it('says it is not measured end to end and that the input guard alone took about 1 h', async () => {
    const text = await descriptionOf({ ramGiB: 64 });

    expect(text).toContain(QUALITY_UNMEASURED);
    expect(text).toMatch(/not measured end to end yet/);
    expect(text).toMatch(/input guard alone took about 1 h/);
    expect(text).toMatch(/reference laptop/);
    expect(text).toMatch(/32 GB/);
  });

  it('says the models need about 66 GB of disk, as the profiles table does', async () => {
    expect(await descriptionOf({ ramGiB: 64 })).toMatch(/about 66 GB of disk/);
  });

  it('does not mention memory when the machine has room to spare', async () => {
    expect(await descriptionOf({ ramGiB: 64 })).not.toMatch(/GiB/);
    expect(await descriptionOf({ ramGiB: 48 })).not.toMatch(/GiB/);
  });

  it('warns at 32 GiB, the size of the machine quality swapped on, and says why', async () => {
    const text = await descriptionOf({ ramGiB: 32 });

    expect(text).toMatch(/This machine has 32\.0 GiB of RAM, which is tight for quality/);
    expect(text).toMatch(/8 of 9 GB of swap/);
    expect(text).not.toMatch(/quality needs about 32 GB/);
  });

  it('allows 5% under 32 GiB: a "32 GB" Linux box that reports 31 GiB gets the tight warning, not the short one', async () => {
    expect(await descriptionOf({ ramGiB: 30.5 })).toMatch(/tight for quality/);
    expect(await descriptionOf({ ramGiB: 30 })).toMatch(
      /This machine has 30\.0 GiB of RAM; quality needs about 32 GB\./,
    );
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

  it('does not warn inside Docker when the limit leaves room', async () => {
    const text = await descriptionOf({ inDocker: true, ramGiB: 64, memoryLimitGiB: 48 });

    expect(text).not.toMatch(/GiB/);
  });

  it('calls a 32 GiB container limit tight, with the swap it caused', async () => {
    const text = await descriptionOf({ inDocker: true, ramGiB: 64, memoryLimitGiB: 32 });

    expect(text).toMatch(
      /Docker limits this container to 32\.0 GiB \(the container limit\), which is tight for quality/,
    );
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
    [64, undefined],
    [48, undefined],
    [45.7, undefined],
    [45.5, 'tight'],
    [32, 'tight'],
    [30.4, 'tight'],
    [30.3, 'short'],
    [24, 'short'],
    [16, 'short'],
  ] as const)('%d GiB of RAM: the warning is %s', (ramGiB, kind) => {
    const text = warn({ ramGiB });

    if (kind === undefined) expect(text).toBeUndefined();
    else if (kind === 'tight') expect(text).toMatch(/tight for quality/);
    else expect(text).toMatch(/quality needs about 32 GB/);
  });

  it('names the measured swap and time at exactly 32 GiB, and keeps light as the way out', () => {
    expect(warn({ ramGiB: 32 })).toBe(
      `This machine has 32.0 GiB of RAM, which is tight for quality: ${QUALITY_TIGHT_RAM}.`,
    );
    expect(QUALITY_TIGHT_RAM).toMatch(/input guard alone took about 1 h/);
    expect(QUALITY_TIGHT_RAM).toMatch(/8 of 9 GB of swap/);
    expect(QUALITY_TIGHT_RAM).toMatch(/M1 Pro/);
    expect(QUALITY_TIGHT_RAM).toMatch(/light needs 16 GB and took about 6 min for a whole week/);
  });

  it('keeps the Docker wording and the Ollama-may-run-elsewhere hint on the tight warning', () => {
    expect(warn({ inDocker: true, ramGiB: 32 })).toBe(
      `Docker shows this container 32.0 GiB of RAM, which is tight for quality: ${QUALITY_TIGHT_RAM}. Ollama may run elsewhere with more.`,
    );
  });

  it('allows 5% under 32 GiB, for the memory a kernel keeps for itself', () => {
    const at = qualityMemoryWarning({ ...harness().io, totalMemoryBytes: 32 * GIB * 0.95 }, false);
    const below = qualityMemoryWarning(
      { ...harness().io, totalMemoryBytes: 32 * GIB * 0.95 - 1 },
      false,
    );

    expect(at).toMatch(/tight for quality/);
    expect(below).toMatch(/quality needs about 32 GB/);
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
