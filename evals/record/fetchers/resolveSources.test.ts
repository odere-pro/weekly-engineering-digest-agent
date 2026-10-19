import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoadOptions } from '../../../src/config/load';
import { DigestError } from '../../../src/shared/errors';
import { DEFAULT_SOURCES } from '../../../src/sources/defaultSources';
import { CONFIG_FIXTURES } from '../__fixtures__/recordKit';
import { resolveSources } from './resolveSources';

const noEnv = (overrides: LoadOptions = {}): LoadOptions => ({
  envPath: join(CONFIG_FIXTURES, 'missing.env'),
  processEnv: {},
  platform: { os: 'darwin', arch: 'arm64' },
  ...overrides,
});

describe('resolveSources', () => {
  it('falls back to the default allowlist when there is no config file', async () => {
    const resolved = await resolveSources(
      noEnv({ configPath: join(CONFIG_FIXTURES, 'missing.json') }),
    );

    expect(resolved.sources).toEqual(DEFAULT_SOURCES);
    expect(resolved.origin).toBe('default');
    expect(resolved.githubToken).toBeUndefined();
  });

  it('uses the configured sources and the GitHub token from the environment', async () => {
    const resolved = await resolveSources(
      noEnv({
        configPath: join(CONFIG_FIXTURES, 'valid.config.json'),
        processEnv: { GITHUB_TOKEN: 'ghp_example' },
      }),
    );

    expect(resolved.sources.map((source) => source.id)).toEqual(['example-feed']);
    expect(resolved.origin).toBe('config');
    expect(resolved.githubToken).toBe('ghp_example');
  });

  it('has no token when the environment has none', async () => {
    const resolved = await resolveSources(
      noEnv({ configPath: join(CONFIG_FIXTURES, 'valid.config.json') }),
    );

    expect(resolved.githubToken).toBeUndefined();
  });

  it('fails when the config path cannot be checked instead of using the defaults', async () => {
    await expect(
      resolveSources(
        noEnv({ configPath: join(CONFIG_FIXTURES, 'valid.config.json', 'nested.json') }),
      ),
    ).rejects.toThrow(/ENOTDIR/);
  });

  it('fails on an invalid config instead of silently using the defaults', async () => {
    await expect(
      resolveSources(noEnv({ configPath: join(CONFIG_FIXTURES, 'bad-schema.config.json') })),
    ).rejects.toBeInstanceOf(DigestError);
  });
});
