// `docker/pull-models.sh` lists the Ollama models the Linux container pulls, by hand, in POSIX sh
// (the image has no node). The list must equal what `src/config/profiles.ts` resolves for a
// non-Apple host, the way `docker/printLinuxModels.mjs` prints it. This test runs the real script
// with `--list`, which pulls nothing, and fails when the two drift. `docker/validate.sh` does the
// same by hand, with docker.
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MODEL_TAGS,
  NON_MAC_FALLBACK,
  requiredModels,
  resolveProfile,
  type Platform,
} from '../../src/config/profiles';
import { ProfileNameSchema } from '../../src/config/schema';
import { useDataDir } from './harness/dataDir';

const SCRIPT_PATH = fileURLToPath(new URL('../../docker/pull-models.sh', import.meta.url));
/** The container is Linux, whatever machine builds it. */
const LINUX: Platform = { os: 'linux', arch: 'x64' };
const SCRIPT_TOOLS = ['sh', 'tr', 'sed', 'awk', 'grep'];
const PROFILE_NAMES = ProfileNameSchema.options;

/** The script needs a POSIX shell and four tools, not docker or ollama. Windows has no `sh`. */
function hasScriptTools(): boolean {
  const probe = spawnSync(
    'sh',
    [
      '-c',
      `for tool in ${SCRIPT_TOOLS.join(' ')}; do command -v "$tool" >/dev/null || exit 1; done`,
    ],
    { encoding: 'utf8' },
  );
  return probe.status === 0;
}

/** What `printLinuxModels.mjs` prints: the quality profile with the non-Apple fallback models. */
function linuxModels(): string[] {
  return requiredModels({ name: 'quality', ...NON_MAC_FALLBACK });
}

interface ListResult {
  /** The tags the script printed, one per line. */
  tags: string[];
  /** Every call the script made to `ollama`; empty when it made none. */
  ollamaCalls: string;
}

const TOOLS_PRESENT = hasScriptTools();
const SUITE_NAME = TOOLS_PRESENT
  ? 'docker/pull-models.sh --list'
  : `docker/pull-models.sh --list (skipped: needs ${SCRIPT_TOOLS.join(', ')} on PATH)`;

describe.skipIf(!TOOLS_PRESENT)(SUITE_NAME, () => {
  const dir = useDataDir();

  async function configWithWriters(writers: readonly string[]): Promise<string> {
    const path = join(dir(), 'digest.config.json');
    await writeFile(path, JSON.stringify({ models: { writers } }, null, 2), 'utf8');
    return path;
  }

  /** Runs the script with `--list`, with a stand-in `ollama` first on PATH that records its calls. */
  async function list(configPath: string): Promise<ListResult> {
    const bin = join(dir(), 'bin');
    const ollama = join(bin, 'ollama');
    const callsFile = join(dir(), 'ollama-calls');
    await mkdir(bin);
    await writeFile(ollama, `#!/bin/sh\necho "$@" >>'${callsFile}'\n`, 'utf8');
    await chmod(ollama, 0o755);
    const result = spawnSync('sh', [SCRIPT_PATH, '--list'], {
      encoding: 'utf8',
      env: { ...process.env, DIGEST_CONFIG: configPath, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return {
      tags: result.stdout.split('\n').filter((line) => line !== ''),
      ollamaCalls: await readFile(callsFile, 'utf8').catch(() => ''),
    };
  }

  it('lists the models profiles.ts needs on Linux when the config has no override', async () => {
    const { tags } = await list(join(dir(), 'no-such-config.json'));

    expect(tags).toEqual(linuxModels());
  });

  it.each(PROFILE_NAMES)(
    'matches what the %s profile resolves to on a Linux host',
    async (name) => {
      const { tags } = await list(join(dir(), 'no-such-config.json'));

      expect(tags).toEqual(requiredModels(resolveProfile(name, LINUX)));
    },
  );

  it('follows models.writers from the config as the loader does', async () => {
    const writers = [MODEL_TAGS.gemma31b, MODEL_TAGS.nemotronLightningMlx];

    const { tags } = await list(await configWithWriters(writers));

    expect(tags).toEqual(requiredModels(resolveProfile('quality', LINUX, writers)));
    expect(tags).toEqual(expect.arrayContaining(writers));
  });

  it('lists a tag once when the config repeats one the script already has', async () => {
    const { tags } = await list(await configWithWriters([MODEL_TAGS.gemma31b]));

    expect(tags).toEqual(linuxModels());
  });

  it('pulls nothing: it never calls ollama', async () => {
    const { ollamaCalls } = await list(join(dir(), 'no-such-config.json'));

    expect(ollamaCalls).toBe('');
  });
});
