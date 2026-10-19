import { describe, expect, it, vi } from 'vitest';
import { buildWritePrompt } from './writePrompt';
import type { DigestItem, Item } from '../domain/schemas';
import type { ScoredItem } from '../classify/classification';
import { writeStep, type WriteDeps } from './write';
import type { GenerateRequest } from '../models/ModelProvider';
import type { Logger } from '../shared/telemetry';
import { makeDigestItem, makeScoredItem } from '../../test/builders';
import { FakeModelProvider, noopLogger } from '../../test/fakes';

const WEEK_ID = '2026-W42';
const FOCUS_AREAS = ['AI models and tooling', 'Platform engineering'] as const;

/** An item as a writer sends it: since W8-01 the writer schema requires urgency and action. */
function writerItem(item: Item, overrides: Partial<DigestItem> = {}): DigestItem {
  return makeDigestItem(item, {
    urgency: 'worth-a-look',
    action: 'Relevant if you run it.',
    ...overrides,
  });
}

function makeItems(count = 4): ScoredItem[] {
  return Array.from({ length: count }, (_, i) =>
    makeScoredItem({ title: `Tool ${i + 1} ships`, summary: `Tool ${i + 1} adds a feature.` }),
  );
}

function body(items: readonly DigestItem[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    headline: 'Three releases worth your time',
    intro: 'Platform and model tooling moved this week.',
    items,
    ...extra,
  });
}

function bodyFor(items: readonly ScoredItem[]): string {
  return body(items.map((item) => writerItem(item)));
}

function makeDeps(model: FakeModelProvider, overrides: Partial<WriteDeps> = {}): WriteDeps {
  return {
    model,
    writers: ['writer-a', 'writer-b'],
    focusAreas: FOCUS_AREAS,
    weekId: WEEK_ID,
    logger: noopLogger,
    ...overrides,
  };
}

/** Replies per writer tag, in call order; a function reply may throw. */
function scripted(
  replies: Readonly<Record<string, readonly (string | (() => string))[]>>,
): FakeModelProvider {
  const queues = new Map(Object.entries(replies).map(([writer, list]) => [writer, [...list]]));
  return new FakeModelProvider({
    generate: (request: GenerateRequest) => {
      const reply = queues.get(request.model ?? '')?.shift();
      if (reply === undefined) throw new Error(`no scripted reply for ${request.model ?? '?'}`);
      return typeof reply === 'function' ? reply() : reply;
    },
  });
}

function makeSpyLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: Logger = { ...noopLogger, warn, child: () => logger };
  return { logger, warn };
}

describe('writeStep titles (F32)', () => {
  async function titleOf(drafted: string): Promise<string | undefined> {
    // The source carries the drafted title: a title naming a version its source lacks is
    // repaired (W12-02), and these cases are about the tidying that follows.
    const [source, ...others] = makeItems(3);
    const items = [{ ...source!, title: drafted }, ...others];
    const first = writerItem(items[0]!, { title: drafted });
    const rest = items.slice(1).map((item) => writerItem(item));
    const model = scripted({ 'writer-a': [body([first, ...rest])] });

    const result = await writeStep(items, makeDeps(model, { writers: ['writer-a'] }));

    return result.drafts[0]?.digest.items[0]?.title;
  }

  it.each([
    ['transformers v5.20.0: Release v5.20.0', 'transformers v5.20.0'],
    ['transformers v5.20.0: v5.20.0', 'transformers v5.20.0'],
    ['kubernetes v1.34: Version 1.34', 'kubernetes v1.34'],
    ['foo 1.2.0-rc1: Release 1.2.0-rc1', 'foo 1.2.0-rc1'],
    ['Release v5.20.0: Release v5.20.0', 'Release v5.20.0'],
  ])('collapses a title that only restates its own release tag: %s', async (title, expected) => {
    expect(await titleOf(title)).toBe(expected);
  });

  it.each([
    'Kubernetes v1.34: Of Wind & Will',
    'foo v2.0.0: Release v2.0.1',
    'Runner 2.4 adds ephemeral GPU runners',
    'Node.js 22: Release notes',
    'transformers v5.20.0 adds Muse Spark Open',
  ])('leaves a title that says something new alone: %s', async (title) => {
    expect(await titleOf(title)).toBe(title);
  });

  it('stays fast on a hostile title made of dots', async () => {
    const started = performance.now();

    const title = await titleOf(`tool v1.0.0: ${'.'.repeat(80_000)}x`);

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(title).toContain('tool v1.0.0');
  });

  it('only looks at the first colon', async () => {
    expect(await titleOf('tool v1.0.0: Release v1.0.0: the big one')).toBe(
      'tool v1.0.0: Release v1.0.0: the big one',
    );
  });
});

describe('writeStep', () => {
  it('calls the writers one after another with their own model tag and the write role', async () => {
    const items = makeItems();
    let active = 0;
    let maxActive = 0;
    const model = new FakeModelProvider({
      generate: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return bodyFor(items.slice(0, 3));
      },
    });

    const result = await writeStep(items, makeDeps(model, { writers: ['w1', 'w2', 'w3'] }));

    expect(maxActive).toBe(1);
    expect(model.generateCalls.map((call) => call.model)).toEqual(['w1', 'w2', 'w3']);
    expect(model.generateCalls.every((call) => call.role === 'write')).toBe(true);
    expect(result.drafts.map((draft) => draft.writer)).toEqual(['w1', 'w2', 'w3']);
    expect(result.failures).toEqual([]);
  });

  it('gives every writer the same prompt built from the items and focus areas', async () => {
    const items = makeItems();
    const model = new FakeModelProvider({ generate: () => bodyFor(items.slice(0, 3)) });

    await writeStep(items, makeDeps(model));

    const expected = buildWritePrompt(items, FOCUS_AREAS);
    for (const call of model.generateCalls) {
      expect(call.system).toBe(expected.system);
      expect(call.prompt).toBe(expected.prompt);
      expect(call.jsonSchema).toMatchObject({ type: 'object' });
    }
  });

  it('overwrites each url with the source url', async () => {
    const items = makeItems(3);
    const drafted = items.map((item) => writerItem(item, { url: 'https://evil.example/x' }));
    const model = scripted({ 'writer-a': [body(drafted)] });

    const result = await writeStep(items, makeDeps(model, { writers: ['writer-a'] }));

    expect(result.drafts[0]?.digest.items.map((item) => item.url)).toEqual(
      items.map((item) => item.url),
    );
  });

  it.each([
    ['is not a URL', 'not a url at all'],
    ['is relative', '/releases/tag/v1'],
    ['is empty', ''],
  ])(
    'does not repair a draft whose model url %s, since the url is replaced anyway',
    async (_name, url) => {
      const items = makeItems(3);
      const drafted = items.map((item) => writerItem(item, { url }));
      const model = scripted({ 'writer-a': [body(drafted)] });

      const result = await writeStep(items, makeDeps(model, { writers: ['writer-a'] }));

      expect(model.generateCalls).toHaveLength(1);
      expect(result.failures).toEqual([]);
      expect(result.drafts[0]?.digest.items.map((item) => item.url)).toEqual(
        items.map((item) => item.url),
      );
    },
  );

  it('accepts an item whose url the model sent as null', async () => {
    const items = makeItems(3);
    const drafted = items.map((item) => ({ ...writerItem(item), url: null }));
    const model = scripted({
      'writer-a': [JSON.stringify({ headline: 'H', intro: 'I', items: drafted })],
    });

    const result = await writeStep(items, makeDeps(model, { writers: ['writer-a'] }));

    expect(model.generateCalls).toHaveLength(1);
    expect(result.drafts[0]?.digest.items.map((item) => item.url)).toEqual(
      items.map((item) => item.url),
    );
  });

  it('still rejects a digest with no items', async () => {
    const items = makeItems(3);
    const model = scripted({ 'writer-a': [body([]), body([])] });

    const result = await writeStep(items, makeDeps(model, { writers: ['writer-a'] }));

    expect(result.drafts).toEqual([]);
    expect(result.failures[0]?.error).toMatch(/failed validation/);
  });

  it('accepts an item the model sent without a url and sets the source url', async () => {
    const items = makeItems(3);
    const drafted = items.map((item) => {
      const { url: _omitted, ...rest } = writerItem(item);
      return rest as DigestItem;
    });
    const model = scripted({ 'writer-a': [body(drafted)] });

    const result = await writeStep(items, makeDeps(model, { writers: ['writer-a'] }));

    expect(model.generateCalls).toHaveLength(1);
    expect(result.drafts[0]?.digest.items.map((item) => item.url)).toEqual(
      items.map((item) => item.url),
    );
  });

  it('does not ask the model for a valid url in the schema it sends', async () => {
    const items = makeItems(3);
    const model = new FakeModelProvider({ generate: () => bodyFor(items) });

    await writeStep(items, makeDeps(model, { writers: ['writer-a'] }));

    const schema = JSON.stringify(model.generateCalls[0]?.jsonSchema);
    expect(schema).not.toContain('"format":"uri"');
    expect(schema).not.toMatch(/"required":\[[^\]]*"url"/);
  });

  it('still repairs a draft when another field is invalid', async () => {
    const items = makeItems(3);
    const broken = items.map((item) => writerItem(item, { whyItMatters: '' }));
    const model = scripted({ 'writer-a': [body(broken), bodyFor(items)] });

    const result = await writeStep(items, makeDeps(model, { writers: ['writer-a'] }));

    expect(model.generateCalls).toHaveLength(2);
    expect(result.drafts).toHaveLength(1);
  });

  it('removes items with an unknown itemId and keeps the rest in order', async () => {
    const items = makeItems(4);
    const drafted = [
      writerItem(items[2]!),
      { ...writerItem(items[0]!), itemId: 'made-up' },
      writerItem(items[1]!),
      writerItem(items[3]!),
    ];
    const { logger, warn } = makeSpyLogger();
    const model = scripted({ 'writer-a': [body(drafted)] });

    const result = await writeStep(items, makeDeps(model, { writers: ['writer-a'], logger }));

    expect(result.drafts[0]?.digest.items.map((item) => item.itemId)).toEqual([
      items[2]!.id,
      items[1]!.id,
      items[3]!.id,
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/unknown itemId/i),
      expect.objectContaining({ itemId: 'made-up' }),
    );
  });

  it('keeps only the first entry when a writer repeats an item', async () => {
    const items = makeItems(3);
    const drafted = [
      writerItem(items[0]!),
      writerItem(items[0]!, { summary: 'Again.' }),
      writerItem(items[1]!),
      writerItem(items[2]!),
    ];
    const model = scripted({ 'writer-a': [body(drafted)] });

    const result = await writeStep(items, makeDeps(model, { writers: ['writer-a'] }));

    const kept = result.drafts[0]?.digest.items ?? [];
    expect(kept.map((item) => item.itemId)).toEqual(items.map((item) => item.id));
    expect(kept[0]?.summary).not.toBe('Again.');
  });

  it('fails a writer whose repeats leave fewer than 3 distinct items', async () => {
    const items = makeItems(3);
    const drafted = [items[0]!, items[0]!, items[0]!].map((item) => writerItem(item));
    const model = scripted({ 'writer-a': [body(drafted)] });

    const result = await writeStep(items, makeDeps(model, { writers: ['writer-a'] }));

    expect(result.drafts).toEqual([]);
    expect(result.failures[0]?.error).toMatch(/1 valid items/);
  });

  it('logs a long unknown itemId cut short', async () => {
    const items = makeItems(3);
    const longId = 'x'.repeat(5_000);
    const drafted = [
      ...items.map((item) => writerItem(item)),
      { ...writerItem(items[0]!), itemId: longId },
    ];
    const { logger, warn } = makeSpyLogger();
    const model = scripted({ 'writer-a': [body(drafted)] });

    await writeStep(items, makeDeps(model, { writers: ['writer-a'], logger }));

    const fields = warn.mock.calls.find(([message]) =>
      /unknown itemId/.test(String(message)),
    )?.[1] as { itemId: string } | undefined;
    expect(fields?.itemId.length).toBeLessThanOrEqual(80);
  });

  it('fails a writer left with fewer than 3 valid items and still runs the next one', async () => {
    const items = makeItems(4);
    const weak = [
      writerItem(items[0]!),
      writerItem(items[1]!),
      { ...writerItem(items[2]!), itemId: 'ghost-1' },
      { ...writerItem(items[3]!), itemId: 'ghost-2' },
    ];
    const { logger, warn } = makeSpyLogger();
    const model = scripted({
      'writer-a': [body(weak)],
      'writer-b': [bodyFor(items.slice(0, 3))],
    });

    const result = await writeStep(items, makeDeps(model, { logger }));

    expect(result.failures).toEqual([
      { writer: 'writer-a', error: expect.stringMatching(/2 valid items.*at least 3/i) as string },
    ]);
    expect(result.drafts.map((draft) => draft.writer)).toEqual(['writer-b']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/writer failed/i),
      expect.objectContaining({ error: expect.any(String) as string }),
    );
  });

  it('lists a writer whose output fails validation after one repair and runs the next', async () => {
    const items = makeItems();
    const model = scripted({
      'writer-a': ['not json', '{"headline": ""}'],
      'writer-b': [bodyFor(items.slice(0, 3))],
    });

    const result = await writeStep(items, makeDeps(model));

    expect(model.generateCalls.map((call) => call.model)).toEqual([
      'writer-a',
      'writer-a',
      'writer-b',
    ]);
    expect(result.failures).toEqual([
      {
        writer: 'writer-a',
        error: expect.stringMatching(/failed validation[\s\S]*headline/) as string,
      },
    ]);
    expect(result.drafts.map((draft) => draft.writer)).toEqual(['writer-b']);
  });

  it('accepts a draft that the one repair fixed', async () => {
    const items = makeItems();
    const model = scripted({ 'writer-a': ['{"oops": true}', bodyFor(items.slice(0, 3))] });

    const result = await writeStep(items, makeDeps(model, { writers: ['writer-a'] }));

    expect(result.drafts).toHaveLength(1);
    expect(result.failures).toEqual([]);
  });

  it('lists a writer whose model call throws and runs the next', async () => {
    const items = makeItems();
    const model = scripted({
      'writer-a': [
        () => {
          throw new Error('Ollama unreachable');
        },
      ],
      'writer-b': [bodyFor(items.slice(0, 3))],
    });

    const result = await writeStep(items, makeDeps(model));

    expect(result.failures).toEqual([{ writer: 'writer-a', error: 'Ollama unreachable' }]);
    expect(result.drafts.map((draft) => draft.writer)).toEqual(['writer-b']);
  });

  it('returns no drafts when every writer fails', async () => {
    const items = makeItems();
    const model = new FakeModelProvider({ generate: () => 'not json' });

    const result = await writeStep(items, makeDeps(model));

    expect(result.drafts).toEqual([]);
    expect(result.failures.map((failure) => failure.writer)).toEqual(['writer-a', 'writer-b']);
  });

  it('sets weekId on every draft, ignoring any weekId the model sends', async () => {
    const items = makeItems();
    const drafted = items.slice(0, 3).map((item) => writerItem(item));
    const model = scripted({
      'writer-a': [body(drafted, { weekId: '1999-W01' })],
      'writer-b': [body(drafted)],
    });

    const result = await writeStep(items, makeDeps(model));

    expect(result.drafts).toHaveLength(2);
    expect(result.drafts.every((draft) => draft.digest.weekId === WEEK_ID)).toBe(true);
  });

  it('keeps the drafted headline, intro and item text', async () => {
    const items = makeItems(3);
    const drafted = items.map((item) => writerItem(item, { whyItMatters: `Because ${item.id}.` }));
    const model = scripted({ 'writer-a': [body(drafted)] });

    const result = await writeStep(items, makeDeps(model, { writers: ['writer-a'] }));

    expect(result.drafts[0]).toEqual({
      writer: 'writer-a',
      digest: {
        weekId: WEEK_ID,
        headline: 'Three releases worth your time',
        intro: 'Platform and model tooling moved this week.',
        items: drafted,
      },
    });
  });

  it('does not mutate the input items', async () => {
    const items = makeItems().map((item) => Object.freeze({ ...item }));
    const snapshot = structuredClone(items);
    const drafted = items
      .slice(0, 3)
      .map((item) => writerItem(item, { url: 'https://evil.example/' }));
    const model = scripted({ 'writer-a': [body(drafted)] });

    await writeStep(Object.freeze(items), makeDeps(model, { writers: ['writer-a'] }));

    expect(items).toEqual(snapshot);
  });

  it('fails every writer without a model call when fewer than 3 items come in', async () => {
    const model = new FakeModelProvider({ generate: () => bodyFor(makeItems(3)) });
    const { logger, warn } = makeSpyLogger();

    const result = await writeStep(makeItems(2), makeDeps(model, { logger }));

    expect(model.generateCalls).toEqual([]);
    expect(result.drafts).toEqual([]);
    expect(result.failures).toEqual([
      { writer: 'writer-a', error: expect.stringMatching(/2 input items.*at least 3/) as string },
      { writer: 'writer-b', error: expect.stringMatching(/2 input items.*at least 3/) as string },
    ]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('returns nothing and calls no model when there are no writers', async () => {
    const model = new FakeModelProvider();

    const result = await writeStep(makeItems(), makeDeps(model, { writers: [] }));

    expect(result).toEqual({ drafts: [], failures: [] });
    expect(model.generateCalls).toEqual([]);
  });
});
