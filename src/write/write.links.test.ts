// The link repair seen through the whole step: what `prepareDraft` fixes must pass the link check.
import { describe, expect, it, vi } from 'vitest';
import type { Draft } from '../domain/schemas';
import { writeCheckedStep, type CheckedWriteDeps } from './write';
import type { Logger } from '../shared/telemetry';
import { makeDigestItem, makeScoredItem } from '../../test/builders';
import { FakeModelProvider, noopLogger } from '../../test/fakes';

const DOCKER_URL = 'https://www.docker.com/blog/docker-sandbox-kit-spec-cncf/';
const DOCKER_LINK = 'www.docker.com/blog/docker-sandbox-kit-spec-cncf/';

const summaryOf = (draft: Draft): string => draft.digest.items[0]?.summary ?? '';

describe('writeCheckedStep with a scheme-less link (W5-11)', () => {
  // The first item has a www host, like the docker.com post that left 2026-W39 without a digest.
  const items = [
    makeScoredItem({ url: DOCKER_URL, title: 'Docker sandbox kit spec' }),
    ...['b', 'c'].map((name) =>
      makeScoredItem({ url: `https://example.com/posts/${name}`, title: `Release ${name}` }),
    ),
  ];

  /** The model's JSON body: the items as given, with `summary` on the first one. */
  const body = (summary: string): string =>
    JSON.stringify({
      headline: 'Releases worth a look',
      intro: 'Platform tooling moved this week.',
      items: items.map((item, index) =>
        makeDigestItem(item, {
          urgency: 'worth-a-look',
          action: 'Relevant if you run it.',
          ...(index === 0 ? { summary } : {}),
        }),
      ),
    });

  const depsFor = (model: FakeModelProvider): CheckedWriteDeps => ({
    model,
    writers: ['writer-a'],
    focusAreas: ['Platform engineering'],
    weekId: '2026-W42',
    logger: noopLogger,
    collected: items,
    disabledGuards: [],
    topN: 5,
  });

  it('accepts a first draft whose only fault was a missing https://, without a retry', async () => {
    const reply = body('Read //example.com/posts/b for the spec.');
    const model = new FakeModelProvider({ generate: () => reply });

    const result = await writeCheckedStep(items, depsFor(model));

    expect(model.generateCalls).toHaveLength(1);
    expect(result.rejections).toEqual([]);
    expect(result.checked).toHaveLength(1);
    expect(result.checked[0]?.rejectedBy).toEqual([]);
    expect(summaryOf(result.checked[0]!.draft)).toBe(
      'Read https://example.com/posts/b for the spec.',
    );
    expect(result.checked[0]?.markdown).toContain('Read https://example.com/posts/b for the spec.');
  });

  it('passes a draft that links a www item correctly: no repair, no rejection, no retry', async () => {
    const model = new FakeModelProvider({ generate: () => body('Docker proposes a spec.') });

    const result = await writeCheckedStep(items, depsFor(model));

    expect(model.generateCalls).toHaveLength(1);
    expect(result.rejections).toEqual([]);
    expect(result.checked[0]?.rejectedBy).toEqual([]);
    expect(result.checked[0]?.markdown).toContain(`](${DOCKER_URL})`);
  });

  it('accepts a www item the writer linked without its scheme, after repairing it', async () => {
    const reply = body(`See [the spec](${DOCKER_LINK}) for details.`);
    const model = new FakeModelProvider({ generate: () => reply });

    const result = await writeCheckedStep(items, depsFor(model));

    expect(model.generateCalls).toHaveLength(1);
    expect(result.rejections).toEqual([]);
    expect(summaryOf(result.checked[0]!.draft)).toBe(`See [the spec](${DOCKER_URL}) for details.`);
  });

  it('repairs the retry draft too, and the retry then passes', async () => {
    const replies = [
      body('Read //evil.example/payload for the spec.'),
      body('Read //example.com/posts/b for the spec.'),
    ];
    const model = new FakeModelProvider({ generate: () => replies.shift() ?? '' });

    const result = await writeCheckedStep(items, depsFor(model));

    expect(model.generateCalls).toHaveLength(2);
    expect(result.rejections.map((rejection) => rejection.attempt)).toEqual([1]);
    expect(result.checked[0]?.rejectedBy).toEqual([]);
    expect(result.checked[0]?.markdown).toContain('Read https://example.com/posts/b for');
  });

  it('logs how many links it fixed, and nothing when there were none', async () => {
    const info = vi.fn();
    const logger: Logger = { ...noopLogger, info, child: () => logger };
    const twice = body(
      'Read //example.com/posts/b and www.example.com/none, then //example.com/posts/c.',
    );
    const model = new FakeModelProvider({ generate: () => twice });

    await writeCheckedStep(items, { ...depsFor(model), logger });

    expect(info).toHaveBeenCalledWith('Added https:// to links the writer left bare', {
      writer: 'writer-a',
      links: 2,
    });

    info.mockClear();
    const clean = new FakeModelProvider({ generate: () => body('Nothing to fix here.') });
    await writeCheckedStep(items, { ...depsFor(clean), logger });
    expect(info).not.toHaveBeenCalledWith(
      'Added https:// to links the writer left bare',
      expect.anything(),
    );
  });

  it('still rejects, retries and records a draft whose link is not a collected url', async () => {
    const reply = body('Read //evil.example/payload for the spec.');
    const model = new FakeModelProvider({ generate: () => reply });

    const result = await writeCheckedStep(items, depsFor(model));

    expect(model.generateCalls).toHaveLength(2);
    expect(result.rejections.map((rejection) => rejection.attempt)).toEqual([1, 2]);
    expect(result.rejections[0]?.problems.join('\n')).toContain('//evil.example/payload');
    expect(result.checked[0]?.rejectedBy).toContain('linkCheck');
    expect(result.checked[0]?.markdown).not.toContain('https://evil.example');
  });
});
