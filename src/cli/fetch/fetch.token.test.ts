import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGithubReleasesFetcher } from '../../sources/adapters/githubReleases';
import { fetchCommand } from './fetch';
import {
  NOW,
  REPO,
  REPO_API_URL,
  REPO_ATOM_URL,
  RSS,
  TOKEN,
  allFiles,
  defaultRoutes,
  fixture,
  harness,
  pathsIn,
  savedItems,
  serving,
  sourceFiles,
  tableRows,
  useTempDir,
  type Harness,
  type HarnessOptions,
} from './__fixtures__/fetchHarness';

const dir = useTempDir();
const setup = (options: HarnessOptions = {}): Promise<Harness> => harness(dir(), options);
const paths = (): ReturnType<typeof pathsIn> => pathsIn(dir());

describe('fetchCommand: the GitHub token', () => {
  it('sends it to the API and never saves or prints it', async () => {
    const h = await setup({ sources: [REPO], secrets: { GITHUB_TOKEN: TOKEN } });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(0);
    expect(h.calls.map((call) => call.url)).toEqual([REPO_API_URL]);
    expect(h.calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(await allFiles(paths().runFolder)).toEqual([
      ...sourceFiles('acme-widgets', 'json'),
      'fetch-summary.json',
    ]);
    await expectNoSecretAnywhere(h, TOKEN);
  });

  it('saves what the fetcher of a run returns with a token, item for item', async () => {
    const routes = await defaultRoutes();
    const h = await setup({ sources: [REPO], routes, secrets: { GITHUB_TOKEN: TOKEN } });
    const window = { since: new Date('2026-10-06T00:00:00Z'), until: new Date(NOW), maxItems: 20 };
    const run = createGithubReleasesFetcher({ fetch: serving(routes).fetch, token: TOKEN });

    await fetchCommand({}, h.deps);

    expect(await savedItems(dir(), 'acme-widgets')).toEqual(await run.fetch(REPO, window));
  });

  it.each([
    ['the table cut', 70],
    ['the summary cut', 285],
  ])('is removed from an error text before %s, so no piece of it is left', async (_name, at) => {
    const message = `${'x'.repeat(at)}${TOKEN}`;
    const h = await setup({
      routes: { [RSS.url]: new Error(message) },
      secrets: { GITHUB_TOKEN: TOKEN },
    });

    await fetchCommand({}, h.deps);

    expect(h.out() + (await readFile(paths().summaryPath, 'utf8'))).not.toContain('ghp_');
  });

  it("leaves a feed's own words alone when another secret is a common word", async () => {
    const h = await setup({ secrets: { SMTP_PASSWORD: 'Postgres' } });

    await fetchCommand({}, h.deps);

    expect(await readFile(paths().rawPath('example-feed', 'xml'), 'utf8')).toBe(
      await fixture('feeds/rss2.xml'),
    );
    const items = await savedItems(dir(), 'example-feed');
    expect(items.map((item) => item.title)).toContain('Postgres 19 beta');
  });

  it('still removes that other secret from an error text', async () => {
    const routes = { [RSS.url]: new Error('login failed for hunter2') };
    const h = await setup({ routes, secrets: { SMTP_PASSWORD: 'hunter2' } });

    await fetchCommand({}, h.deps);

    expect(tableRows(h.out())[1]?.at(-1)).toBe('login failed for [redacted]');
    expect(await readFile(paths().summaryPath, 'utf8')).not.toContain('hunter2');
  });

  it('reads the public feed, with no authorization, when there is no token', async () => {
    const h = await setup({ sources: [REPO] });

    await fetchCommand({}, h.deps);

    expect(h.calls.map((call) => call.url)).toEqual([REPO_ATOM_URL]);
    expect(h.calls[0]?.headers.has('authorization')).toBe(false);
  });

  it('keeps it out of an error that echoes it', async () => {
    const routes = { [REPO_API_URL]: new Error(`socket closed for Bearer ${TOKEN}`) };
    const h = await setup({ sources: [REPO], secrets: { GITHUB_TOKEN: TOKEN }, routes });

    const code = await fetchCommand({}, h.deps);

    expect(code).toBe(1);
    expect(h.out()).toContain('[redacted]');
    await expectNoSecretAnywhere(h, TOKEN);
  });

  it('keeps it out of a response body that echoes it', async () => {
    const body = JSON.stringify([{ message: `token ${TOKEN} is fine` }]);
    const routes = { [REPO_API_URL]: { body, type: 'application/json' } };
    const h = await setup({ sources: [REPO], secrets: { GITHUB_TOKEN: TOKEN }, routes });

    await fetchCommand({}, h.deps);

    const raw = await readFile(paths().rawPath('acme-widgets', 'json'), 'utf8');
    expect(raw).toContain('[redacted]');
    await expectNoSecretAnywhere(h, TOKEN);
  });
});

async function expectNoSecretAnywhere(h: Harness, secret: string): Promise<void> {
  expect(h.out()).not.toContain(secret);
  expect(h.err()).not.toContain(secret);
  for (const file of await allFiles(h.dir)) {
    expect(await readFile(join(h.dir, file), 'utf8'), file).not.toContain(secret);
  }
}
