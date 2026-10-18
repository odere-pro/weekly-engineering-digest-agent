import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownFileDelivery } from '../delivery/adapters/markdownFile';
import { buildApp } from './container';
import type { LoadedConfig } from '../config/load';
import { resolveProfile, type Platform } from '../config/profiles';
import { EnvSchema, SecretsSchema, type ConfigInput } from '../config/schema';
import type { Delivery, DigestMessage, DigestView } from '../delivery/Delivery';
import { makeConfig } from '../../test/builders';

// The factory still builds the real channel; the spy only records how it was called.
vi.mock('../delivery/adapters/markdownFile', async (load) => {
  const actual = await load<Record<string, unknown>>();
  return {
    ...actual,
    createMarkdownFileDelivery: vi.fn(
      actual['createMarkdownFileDelivery'] as (...args: never[]) => unknown,
    ),
  };
});

const GITHUB_TOKEN = 'ghp_github-token-82bd';

function loadedConfig(config?: Partial<ConfigInput>): LoadedConfig {
  const built = makeConfig(config);
  const platform: Platform = { os: 'darwin', arch: 'arm64' };
  return {
    config: built,
    env: EnvSchema.parse({}),
    secrets: SecretsSchema.parse({ GITHUB_TOKEN }),
    profile: resolveProfile(built.profile, platform, built.models.writers),
    platform,
    configPath: '/project/digest.config.json',
  };
}

const VIEW: DigestView = {
  weekId: '2026-W42',
  title: 'Week 2026-W42: 1 release, 1 needs action',
  headline: 'One thing to do.',
  groups: [
    {
      urgency: 'act-now',
      label: 'Act now',
      items: [
        {
          title: 'Gateway 2.0',
          url: `https://example.com/gateway?token=${GITHUB_TOKEN}`,
          whatChanged: `The v1 API is removed (${GITHUB_TOKEN}).`,
          action: 'Move off v1.',
        },
      ],
    },
  ],
};

const MESSAGE: DigestMessage = {
  weekId: '2026-W42',
  subject: 'Engineering digest 2026-W42',
  markdown: `# Week 2026-W42\n\nSee https://example.com/gateway?token=${GITHUB_TOKEN}\n`,
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'container-local-'));
  vi.mocked(createMarkdownFileDelivery).mockClear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function markdownChannel(app: Awaited<ReturnType<typeof buildApp>>): Delivery {
  const channel = app.deps.deliveries.find((delivery) => delivery.id === 'markdown');
  if (!channel) throw new Error('no Markdown delivery');
  return channel;
}

describe('buildApp: the local output folder', () => {
  it('writes to dist/digests when the config does not name a folder', async () => {
    await buildApp(loadedConfig({ dataDir: join(root, 'data') }));

    expect(vi.mocked(createMarkdownFileDelivery)).toHaveBeenCalledExactlyOnceWith({
      dir: 'dist/digests',
    });
  });

  it('writes <week>.md and <week>.html into the configured folder', async () => {
    const dir = join(root, 'out');
    const app = await buildApp(
      loadedConfig({ dataDir: join(root, 'data'), delivery: { markdown: { dir } } }),
    );

    await markdownChannel(app).sendDigest({ ...MESSAGE, view: VIEW });

    expect((await readdir(dir)).sort()).toEqual(['2026-W42.html', '2026-W42.md']);
    expect(await readFile(join(dir, '2026-W42.html'), 'utf8')).toContain('Gateway 2.0');
  });

  it('writes only the Markdown for a digest without a view', async () => {
    const dir = join(root, 'out');
    const app = await buildApp(
      loadedConfig({ dataDir: join(root, 'data'), delivery: { markdown: { dir } } }),
    );

    await markdownChannel(app).sendDigest(MESSAGE);

    expect(await readdir(dir)).toEqual(['2026-W42.md']);
  });

  it('takes the secrets out of both files before they reach the disk', async () => {
    const dir = join(root, 'out');
    const app = await buildApp(
      loadedConfig({ dataDir: join(root, 'data'), delivery: { markdown: { dir } } }),
    );

    await markdownChannel(app).sendDigest({ ...MESSAGE, view: VIEW });

    const markdown = await readFile(join(dir, '2026-W42.md'), 'utf8');
    const html = await readFile(join(dir, '2026-W42.html'), 'utf8');
    expect(markdown).toContain('[redacted]');
    expect(html).toContain('[redacted]');
    expect(markdown + html).not.toContain(GITHUB_TOKEN);
  });
});
