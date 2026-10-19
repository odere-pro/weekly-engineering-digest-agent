import { describe, expect, it, vi } from 'vitest';
import type { DigestItem, Urgency } from '../domain/schemas';
import type { ScoredItem } from '../classify/classification';
import { writeCheckedStep, writeStep, type CheckedWriteDeps, type WriteDeps } from './write';
import type { GenerateRequest } from '../models/ModelProvider';
import type { Logger } from '../shared/telemetry';
import { makeDigestItem, makeScoredItem } from '../../test/builders';
import { FakeModelProvider, noopLogger } from '../../test/fakes';

const WEEK_ID = '2026-W42';
const FOCUS_AREAS = ['AI models and tooling', 'Platform engineering'] as const;

function makeItems(count = 3, overrides: Partial<ScoredItem>[] = []): ScoredItem[] {
  return Array.from({ length: count }, (_, i) =>
    makeScoredItem({
      title: `Tool ${i + 1} ships`,
      summary: `Tool ${i + 1} adds a feature.`,
      ...overrides[i],
    }),
  );
}

function entry(item: ScoredItem, urgency: Urgency, action: string): DigestItem {
  return makeDigestItem(item, { urgency, action });
}

const body = (items: readonly unknown[]): string =>
  JSON.stringify({ headline: 'Three releases', intro: 'Tooling moved.', items });

function deps(model: FakeModelProvider, overrides: Partial<WriteDeps> = {}): WriteDeps {
  return {
    model,
    writers: ['writer-a'],
    focusAreas: FOCUS_AREAS,
    weekId: WEEK_ID,
    logger: noopLogger,
    ...overrides,
  };
}

function scripted(...replies: string[]): FakeModelProvider {
  const queue = [...replies];
  return new FakeModelProvider({
    generate: (_request: GenerateRequest) => {
      const reply = queue.shift();
      if (reply === undefined) throw new Error('no scripted reply left');
      return reply;
    },
  });
}

function spyLogger(): { logger: Logger; info: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  const logger: Logger = { ...noopLogger, info, child: () => logger };
  return { logger, info };
}

describe('writeStep strict writer schema (W8-01)', () => {
  const items = makeItems();
  const good = body(items.map((item) => entry(item, 'worth-a-look', 'Relevant if you run CI')));
  const withoutField = (field: 'urgency' | 'action'): string =>
    body(
      items.map((item) => {
        const { [field]: _dropped, ...rest } = entry(
          item,
          'worth-a-look',
          'Relevant if you run CI',
        );
        return rest;
      }),
    );

  it('asks the model for urgency and action on every item, and only the three urgency values', async () => {
    const model = scripted(good);

    await writeStep(items, deps(model));

    const schema = model.generateCalls[0]?.jsonSchema as {
      properties: { items: { items: { required: string[]; properties: Record<string, unknown> } } };
    };
    const item = schema.properties.items.items;
    expect(item.required).toEqual(expect.arrayContaining(['urgency', 'action']));
    expect(item.properties['urgency']).toMatchObject({
      enum: ['act-now', 'worth-a-look', 'good-to-know'],
    });
  });

  it.each(['urgency', 'action'] as const)(
    'rejects a draft whose items have no %s',
    async (field) => {
      const model = scripted(withoutField(field), withoutField(field));

      const result = await writeStep(items, deps(model));

      expect(result.drafts).toEqual([]);
      expect(result.failures).toEqual([
        { writer: 'writer-a', error: expect.stringMatching(new RegExp(field)) as string },
      ]);
    },
  );

  it('repairs once: a draft that adds the missing urgency on the second try is accepted', async () => {
    const model = scripted(withoutField('urgency'), good);

    const result = await writeStep(items, deps(model));

    expect(model.generateCalls).toHaveLength(2);
    expect(result.failures).toEqual([]);
    expect(result.drafts[0]?.digest.items.map((item) => item.urgency)).toEqual([
      'worth-a-look',
      'worth-a-look',
      'worth-a-look',
    ]);
  });

  it('rejects an urgency that is not one of the three values', async () => {
    const bad = body(items.map((item) => entry(item, 'urgent' as Urgency, 'Do it')));
    const model = scripted(bad, bad);

    const result = await writeStep(items, deps(model));

    expect(result.drafts).toEqual([]);
    expect(result.failures[0]?.error).toMatch(/urgency/);
  });

  it('accepts an empty action, which is what good-to-know carries, and leaves it out of the draft', async () => {
    const model = scripted(body(items.map((item) => entry(item, 'good-to-know', ''))));

    const result = await writeStep(items, deps(model));

    const kept = result.drafts[0]?.digest.items ?? [];
    expect(kept.map((item) => item.urgency)).toEqual([
      'good-to-know',
      'good-to-know',
      'good-to-know',
    ]);
    expect(kept.every((item) => item.action === undefined)).toBe(true);
  });

  it('keeps urgency and a trimmed action on each item, in the order written', async () => {
    const model = scripted(
      body([
        entry(items[0]!, 'act-now', '  Upgrade OpenTofu in CI and on laptops \n'),
        entry(items[1]!, 'worth-a-look', 'Relevant if you run model evals in CI.'),
        entry(items[2]!, 'good-to-know', ''),
      ]),
    );

    const result = await writeStep(items, deps(model));

    expect(
      result.drafts[0]?.digest.items.map(({ urgency, action }) => ({ urgency, action })),
    ).toEqual([
      { urgency: 'act-now', action: 'Upgrade OpenTofu in CI and on laptops' },
      { urgency: 'worth-a-look', action: 'Relevant if you run model evals in CI.' },
      { urgency: 'good-to-know', action: undefined },
    ]);
  });
});

describe('writeStep security floor (W8-01)', () => {
  const lowered = (items: readonly ScoredItem[]): string =>
    body(items.map((item) => entry(item, 'good-to-know', '')));

  it.each([
    ['a CVE id in the title', { title: 'parser 2.1.4 fixes CVE-2026-1234' }],
    ['a CVE word in the summary', { summary: 'This release patches two CVEs in the parser.' }],
    ['a security advisory in the summary', { summary: 'See the security advisory for details.' }],
    ['a vulnerability in the title', { title: 'Fix a vulnerability in the TLS stack' }],
    ['a plural vulnerabilities in the summary', { summary: 'Fixes several vulnerabilities.' }],
    ['a GitHub advisory id in the summary', { summary: 'Tracked as GHSA-abcd-1234-wxyz.' }],
    ['a security release in the title', { title: 'Node.js 22.9.1 (Security Release)' }],
    ['a security fix in the summary', { summary: 'Ships a security fix for the HTTP parser.' }],
    ['a security patch in the summary', { summary: 'This security patch is recommended.' }],
    ['a security update in the title', { title: 'Security updates for the runner' }],
    // Deliberate: the floor reads words, not meaning, and errs toward worth-a-look.
    ['the word vulnerability in a scanner feature', { title: 'New vulnerability scanner UI' }],
  ])('raises a good-to-know item to worth-a-look when its source names %s', async (_n, patch) => {
    const items = makeItems(3, [patch]);
    const model = scripted(lowered(items));
    const { logger, info } = spyLogger();

    const result = await writeStep(items, deps(model, { logger }));

    const [first, second] = result.drafts[0]?.digest.items ?? [];
    expect(first?.urgency).toBe('worth-a-look');
    expect(first?.action).toMatch(/^Relevant if you /);
    expect(second?.urgency).toBe('good-to-know');
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/raised urgency/i),
      expect.objectContaining({ itemId: items[0]!.id, from: 'good-to-know', to: 'worth-a-look' }),
    );
  });

  it.each(['Relevant if you run the parser.', 'Check whether the parser is in your images'])(
    'keeps the action the writer gave the raised item: %s',
    async (action) => {
      const items = makeItems(3, [{ title: 'Fix CVE-2026-1234' }]);
      const reply = body([
        entry(items[0]!, 'good-to-know', action),
        entry(items[1]!, 'good-to-know', ''),
        entry(items[2]!, 'good-to-know', ''),
      ]);

      const result = await writeStep(items, deps(scripted(reply)));

      expect(result.drafts[0]?.digest.items[0]).toMatchObject({ urgency: 'worth-a-look', action });
    },
  );

  it.each(['act-now', 'worth-a-look'] as const)(
    'leaves a %s item alone, and does not log',
    async (urgency) => {
      const items = makeItems(3, [{ title: 'Fix CVE-2026-1234' }]);
      const reply = body([
        entry(items[0]!, urgency, 'Upgrade the parser now'),
        entry(items[1]!, 'good-to-know', ''),
        entry(items[2]!, 'good-to-know', ''),
      ]);
      const { logger, info } = spyLogger();

      const result = await writeStep(items, deps(scripted(reply), { logger }));

      expect(result.drafts[0]?.digest.items[0]?.urgency).toBe(urgency);
      expect(info).not.toHaveBeenCalledWith(
        expect.stringMatching(/raised urgency/i),
        expect.anything(),
      );
    },
  );

  it('leaves a good-to-know item alone when its source says nothing about security', async () => {
    const items = makeItems(3, [
      {
        title: 'A secure-by-default setting',
        summary: 'Safe defaults, no advisories mentioned elsewhere.',
      },
    ]);
    const { logger, info } = spyLogger();

    const result = await writeStep(items, deps(scripted(lowered(items)), { logger }));

    expect(result.drafts[0]?.digest.items.map((item) => item.urgency)).toEqual([
      'good-to-know',
      'good-to-know',
      'good-to-know',
    ]);
    expect(info).not.toHaveBeenCalledWith(
      expect.stringMatching(/raised urgency/i),
      expect.anything(),
    );
  });

  it('reads the source, not the writer: a CVE only in the written summary does not raise anything', async () => {
    const items = makeItems(3);
    const reply = body(
      items.map((item) =>
        makeDigestItem(item, {
          urgency: 'good-to-know',
          action: '',
          summary: 'Mentions CVE-2026-1.',
        }),
      ),
    );

    const result = await writeStep(items, deps(scripted(reply)));

    expect(result.drafts[0]?.digest.items[0]?.urgency).toBe('good-to-know');
  });

  it('keeps the raised draft passing the format check, so the floor never causes a retry', async () => {
    const items = makeItems(3, [{ summary: 'Patches a vulnerability.' }]);
    const checkedDeps: CheckedWriteDeps = {
      ...deps(scripted(lowered(items))),
      collected: items,
      disabledGuards: [],
      topN: 5,
    };

    const result = await writeCheckedStep(items, checkedDeps);

    expect(result.checked[0]?.problems).toEqual([]);
    expect(result.checked[0]?.rejectedBy).toEqual([]);
  });
});

describe('writeCheckedStep with the new format checks (W8-01)', () => {
  it('rejects a draft with too many act-now items and retries with that problem in the prompt', async () => {
    const items = makeItems(5);
    const tooMany = body(items.map((item) => entry(item, 'act-now', 'Upgrade it today')));
    const fixed = body(
      items.map((item, i) =>
        i < 3 ? entry(item, 'act-now', 'Upgrade it today') : entry(item, 'good-to-know', ''),
      ),
    );
    const model = scripted(tooMany, fixed);
    const checkedDeps: CheckedWriteDeps = {
      ...deps(model),
      collected: items,
      disabledGuards: [],
      topN: 5,
    };

    const result = await writeCheckedStep(items, checkedDeps);

    expect(result.rejections).toEqual([
      expect.objectContaining({
        writer: 'writer-a',
        attempt: 1,
        rejectedBy: ['formatCheck'],
        problems: ['Expected at most 3 act-now items, got 5'],
      }),
    ]);
    expect(model.generateCalls[1]?.prompt).toContain('Expected at most 3 act-now items, got 5');
    expect(result.checked[0]?.rejectedBy).toEqual([]);
  });

  it('rejects a draft whose act-now item has no action', async () => {
    const items = makeItems(3);
    const missing = body(items.map((item) => entry(item, 'act-now', '')));
    const model = scripted(missing, missing);
    const checkedDeps: CheckedWriteDeps = {
      ...deps(model),
      collected: items,
      disabledGuards: [],
      topN: 5,
    };

    const result = await writeCheckedStep(items, checkedDeps);

    expect(result.checked[0]?.problems).toEqual(['Missing action in items 1, 2, 3']);
  });
});
