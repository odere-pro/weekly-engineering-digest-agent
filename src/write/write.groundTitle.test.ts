// A title with a version, advisory id or date its source lacks is repaired in code (W12-02), and
// the draft is not rejected for it. Tested through `writeStep` and `writeCheckedStep`.
import { describe, expect, it, vi } from 'vitest';
import type { DigestItem } from '../domain/schemas';
import type { ScoredItem } from '../classify/classification';
import type { Logger } from '../shared/telemetry';
import { writeCheckedStep, writeStep, type CheckedWriteDeps, type WriteDeps } from './write';
import { makeDigestItem, makeScoredItem } from '../../test/builders';
import { FakeModelProvider, noopLogger } from '../../test/fakes';

const WRITER = 'writer-a';
const WEEK_ID = '2026-W42';

function sourcesWith(first: Partial<ScoredItem>): ScoredItem[] {
  return [
    makeScoredItem({ title: 'Kubernetes v1.31.2', summary: 'A patch release.', ...first }),
    makeScoredItem({ title: 'Tool 2 ships', summary: 'Tool 2 adds a feature.' }),
    makeScoredItem({ title: 'Tool 3 ships', summary: 'Tool 3 adds a feature.' }),
  ];
}

/** What a writer replies: every source as an item, the first one with the title `firstTitle`. */
function replyFor(sources: readonly ScoredItem[], firstTitle: string): string {
  const items: DigestItem[] = sources.map((source, index) =>
    makeDigestItem(source, {
      ...(index === 0 ? { title: firstTitle } : {}),
      // Fixed: the builder's default summary embeds the source title, which some tests make hostile.
      summary: 'What changed in this release.',
      urgency: 'worth-a-look',
      action: 'Relevant if you run it.',
    }),
  );
  return JSON.stringify({ headline: 'Three releases', intro: 'Platform news.', items });
}

function spyLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: Logger = { ...noopLogger, warn, child: () => logger };
  return { logger, warn };
}

function deps(reply: string, logger: Logger = noopLogger): WriteDeps {
  return {
    model: new FakeModelProvider({ generate: () => reply }),
    writers: [WRITER],
    focusAreas: ['AI models and tooling'],
    weekId: WEEK_ID,
    logger,
  };
}

async function firstTitle(
  sources: readonly ScoredItem[],
  drafted: string,
  logger?: Logger,
): Promise<string | undefined> {
  const output = await writeStep(sources, deps(replyFor(sources, drafted), logger));
  return output.drafts[0]?.digest.items[0]?.title;
}

describe('writeStep title grounding', () => {
  it('replaces a title whose version is not in the source with the source title', async () => {
    const sources = sourcesWith({});

    expect(await firstTitle(sources, 'Kubernetes 1.32.0 fixes a scheduler bug')).toBe(
      'Kubernetes v1.31.2',
    );
  });

  it('keeps a title whose version is in the source', async () => {
    const sources = sourcesWith({});

    expect(await firstTitle(sources, 'Kubernetes 1.31.2 fixes a scheduler bug')).toBe(
      'Kubernetes 1.31.2 fixes a scheduler bug',
    );
  });

  it('keeps a shorter version of the source version (1.31 for 1.31.2)', async () => {
    const sources = sourcesWith({});

    expect(await firstTitle(sources, 'Kubernetes 1.31 gets a patch')).toBe(
      'Kubernetes 1.31 gets a patch',
    );
  });

  it('keeps a title with no fact token', async () => {
    const sources = sourcesWith({});

    expect(await firstTitle(sources, 'Kubernetes ships a patch release')).toBe(
      'Kubernetes ships a patch release',
    );
  });

  it('does not reject the draft or fail the writer for a wrong version', async () => {
    const sources = sourcesWith({});

    const output = await writeStep(sources, deps(replyFor(sources, 'Kubernetes 9.9.9')));

    expect(output.failures).toEqual([]);
    expect(output.drafts).toHaveLength(1);
    expect(output.drafts[0]?.digest.items).toHaveLength(3);
  });

  it('leaves the other items and the source items as they were', async () => {
    const sources = sourcesWith({});
    const before = structuredClone(sources);
    sources.forEach((source) => Object.freeze(source));

    const output = await writeStep(sources, deps(replyFor(sources, 'Kubernetes 9.9.9')));

    expect(sources).toEqual(before);
    expect(output.drafts[0]?.digest.items.map((item) => item.title)).toEqual([
      'Kubernetes v1.31.2',
      'Tool 2 ships',
      'Tool 3 ships',
    ]);
  });

  it('tidies a repaired title that restates its own release tag', async () => {
    const sources = sourcesWith({ title: 'transformers v5.17.0: Release 5.17.0' });

    expect(await firstTitle(sources, 'transformers 5.99.0 is out')).toBe('transformers v5.17.0');
  });

  it('warns once with the item id and the missing fact', async () => {
    const { logger, warn } = spyLogger();
    const sources = sourcesWith({});

    await firstTitle(sources, 'Kubernetes 1.32.0 fixes a scheduler bug', logger);

    const grounding = warn.mock.calls.filter(([message]) => /title/i.test(String(message)));
    expect(grounding).toEqual([
      [expect.any(String), { itemId: sources[0]!.id, missing: ['1.32.0'], missingCount: 1 }],
    ]);
  });
});

describe('writeCheckedStep title grounding', () => {
  /** The checked step on sources whose first item has `source`'s fields, and its model calls. */
  async function checkedWith(source: Partial<ScoredItem>) {
    const sources = sourcesWith(source);
    const model = new FakeModelProvider({ generate: () => replyFor(sources, 'Kubernetes 9.9.9') });
    const checkedDeps: CheckedWriteDeps = {
      ...deps(''),
      model,
      collected: sources,
      disabledGuards: [],
      topN: 5,
    };
    const output = await writeCheckedStep(sources, checkedDeps);
    return { output, calls: model.generateCalls.length };
  }

  it('passes the link and format check with a repaired title, so there is no retry', async () => {
    const { output, calls } = await checkedWith({
      title: 'Kubernetes v1.31.2 \u2014 patch release',
    });

    expect(calls).toBe(1);
    expect(output.rejections).toEqual([]);
    expect(output.checked[0]?.rejectedBy).toEqual([]);
    expect(output.checked[0]?.draft.digest.items[0]?.title).toBe(
      'Kubernetes v1.31.2, patch release',
    );
  });

  it.each([
    ['a url', 'Kubernetes v1.31.2 https://evil.example/x'],
    ['a www address', 'Kubernetes v1.31.2 www.example.com/x'],
    ['a character reference', 'Kubernetes v1.31.2 &#99999999;'],
  ])('is not rejected for %s in the source title', async (_name, title) => {
    const { output, calls } = await checkedWith({ title });

    expect(calls).toBe(1);
    expect(output.rejections).toEqual([]);
    expect(output.checked[0]?.draft.digest.items[0]?.title).toBe('Kubernetes v1.31.2');
  });

  it('is not rejected for a source title of 600 words', async () => {
    const { output } = await checkedWith({ title: `Kubernetes v1.31.2 ${'word '.repeat(600)}` });

    expect(output.rejections).toEqual([]);
  });
});
