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
import type { DigestDeps } from '../digest/types';
import type { Source } from '../domain/schemas';
import type { FetchWindow, SourceFetcher } from '../sources/SourceFetcher';
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
  it("writes into each week's digest folder when the config does not name a folder", async () => {
    const dataDir = join(root, 'dist');
    const app = await buildApp(loadedConfig({ dataDir }));

    expect(vi.mocked(createMarkdownFileDelivery)).toHaveBeenCalledExactlyOnceWith({ dataDir });
    await markdownChannel(app).sendDigest(MESSAGE);
    // 2026-10-12 is the Monday of 2026-W42.
    expect(await readdir(join(dataDir, '2026-10-12', 'digest'))).toEqual(['2026-W42.md']);
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

describe('buildApp: what a run fetched', () => {
  const SOURCE: Source = { id: 'example-news', kind: 'rss', url: 'https://example.com/feed.xml' };
  const WINDOW: FetchWindow = {
    since: new Date('2026-10-12T00:00:00Z'),
    until: new Date('2026-10-19T08:00:00Z'),
    maxItems: 10,
  };
  const FEED =
    '<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>' +
    '<item><title>Gateway 2.0</title><link>https://example.com/gateway</link>' +
    '<pubDate>Wed, 14 Oct 2026 10:00:00 GMT</pubDate>' +
    `<description>Rotate ${GITHUB_TOKEN} now.</description></item></channel></rss>`;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(FEED, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves each source's raw answer and items in the run's Monday folder, without secrets", async () => {
    const dataDir = join(root, 'dist');
    const app = await buildApp(loadedConfig({ dataDir }));

    const items = await app.deps.tracer.span('runDigest', { runId: '2026-W43' }, () =>
      fetcherFor(app.deps, 'rss').fetch(SOURCE, WINDOW),
    );
    // The save runs in the background; closing the app waits for it.
    await app.close();

    // 2026-10-19 is the Monday of 2026-W43.
    const dir = join(dataDir, '2026-10-19', 'example-news');
    const raw = await readFile(join(dir, 'raw', 'response-1.xml'), 'utf8');
    const formatted = await readFile(join(dir, 'formatted', 'items.json'), 'utf8');
    expect(raw).toContain('<title>Gateway 2.0</title>');
    expect(JSON.parse(formatted)).toHaveLength(1);
    expect(items.map((item) => item.title)).toEqual(['Gateway 2.0']);
    for (const text of [raw, formatted]) {
      expect(text).not.toContain(GITHUB_TOKEN);
      expect(text).toContain('[redacted]');
    }
  });

  it('saves nothing for a fetch outside a run', async () => {
    const dataDir = join(root, 'dist');
    const app = await buildApp(loadedConfig({ dataDir }));

    await fetcherFor(app.deps, 'rss').fetch(SOURCE, WINDOW);
    await app.close();

    expect(await readdir(root)).toEqual([]);
  });
});

function fetcherFor(deps: DigestDeps, kind: keyof DigestDeps['fetchers']): SourceFetcher {
  const fetcher = deps.fetchers[kind];
  if (!fetcher) throw new Error(`no ${kind} fetcher`);
  return fetcher;
}
