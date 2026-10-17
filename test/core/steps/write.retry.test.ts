import { describe, expect, it } from 'vitest';
import { buildRetryPrompt } from '../../../src/core/prompts/write.js';
import type { Digest, DigestItem, Draft, ScoredItem } from '../../../src/core/schemas.js';
import {
  prepareDraft,
  retryStep,
  writeStep,
  type WriteDeps,
} from '../../../src/core/steps/write.js';
import type { GenerateRequest } from '../../../src/ports/ModelProvider.js';
import { UNTRUSTED_DATA_RULE } from '../../../src/shared/untrusted.js';
import type { Logger } from '../../../src/shared/telemetry.js';
import { makeDigest, makeDigestItem, makeScoredItem } from '../../builders.js';
import { FakeModelProvider, noopLogger } from '../../fakes/index.js';

const WEEK_ID = '2026-W42';
const FOCUS_AREAS = ['AI models and tooling', 'Platform engineering'] as const;
const EM_DASH = '—';

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
  return body(items.map((item) => makeDigestItem(item)));
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

describe('retryStep (W5-06, F1)', () => {
  it('asks only the named writers, in the order given, each with its own retry prompt', async () => {
    const items = makeItems();
    const model = scripted({
      'writer-b': [bodyFor(items.slice(0, 3))],
      'writer-a': [bodyFor(items.slice(0, 3))],
    });

    const result = await retryStep(
      items,
      [
        { writer: 'writer-b', problems: ['Missing intro'] },
        { writer: 'writer-a', problems: ['Contains an em dash'] },
      ],
      makeDeps(model, { writers: ['writer-a', 'writer-b', 'writer-c'] }),
    );

    const [first, second] = model.generateCalls;
    expect(first).toMatchObject({ role: 'write', model: 'writer-b' });
    expect(first?.prompt).toBe(buildRetryPrompt(items, FOCUS_AREAS, ['Missing intro']).prompt);
    expect(first?.system).toContain(UNTRUSTED_DATA_RULE);
    expect(second?.prompt).toBe(
      buildRetryPrompt(items, FOCUS_AREAS, ['Contains an em dash']).prompt,
    );
    expect(result.drafts.map((draft) => draft.writer)).toEqual(['writer-b', 'writer-a']);
    expect(result.failures).toEqual([]);
  });

  it('turns a writer error into a failure for that writer and goes on', async () => {
    const items = makeItems();
    const failing = () => {
      throw new Error('out of memory');
    };
    const model = scripted({ 'writer-a': [failing], 'writer-b': [bodyFor(items.slice(0, 3))] });

    const result = await retryStep(
      items,
      [
        { writer: 'writer-a', problems: ['x'] },
        { writer: 'writer-b', problems: ['y'] },
      ],
      makeDeps(model),
    );

    expect(result.drafts.map((draft) => draft.writer)).toEqual(['writer-b']);
    expect(result.failures).toEqual([
      { writer: 'writer-a', error: expect.stringContaining('out of memory') as string },
    ]);
  });

  it('marks the log lines of a retry, and only those, with retry: true', async () => {
    const items = makeItems();
    const lines: { message: string; fields: Record<string, unknown> }[] = [];
    const recording = (bound: Record<string, unknown>): Logger => ({
      ...noopLogger,
      info: (message, fields) => lines.push({ message, fields: { ...bound, ...fields } }),
      warn: (message, fields) => lines.push({ message, fields: { ...bound, ...fields } }),
      child: (fields) => recording({ ...bound, ...fields }),
    });
    const failing = () => {
      throw new Error('out of memory');
    };
    const model = scripted({
      'writer-a': [bodyFor(items.slice(0, 3)), bodyFor(items.slice(0, 3))],
      'writer-b': [failing],
    });
    const deps = makeDeps(model, { logger: recording({}) });
    const request = (writer: string) => ({ writer, problems: ['x'] });

    await writeStep(items, { ...deps, writers: ['writer-a'] });
    await retryStep(items, [request('writer-a')], deps);
    await retryStep(items, [request('writer-b')], deps);

    const byMessage = (message: string) => lines.filter((line) => line.message === message);
    expect(byMessage('Writer drafted digest').map((line) => line.fields.retry)).toEqual([
      undefined,
      true,
    ]);
    expect(byMessage('Writer failed').map((line) => line.fields.retry)).toEqual([true]);
  });
});

describe('prepareDraft (moved from runDigest by W5-06)', () => {
  const draftOf = (count: number, overrides: Partial<Digest> = {}): Draft => ({
    writer: 'writer-a',
    digest: makeDigest(makeItems(count), overrides),
  });

  it('keeps at most topN items and does not change the draft it was given', () => {
    const draft = draftOf(5);
    const snapshot = structuredClone(draft);

    const prepared = prepareDraft(draft, 3, []);

    expect(prepared.digest.items).toHaveLength(3);
    expect(prepared.writer).toBe('writer-a');
    expect(draft).toEqual(snapshot);
  });

  it('replaces a run of em dashes with one comma, and drops them at the ends of a field', () => {
    const prepared = prepareDraft(
      draftOf(3, {
        headline: `${EM_DASH} Runners, ${EM_DASH} gateways ${EM_DASH}`,
        intro: `Fast ${EM_DASH}${EM_DASH} faster`,
      }),
      5,
      [],
    );

    expect(prepared.digest.headline).toBe('Runners, gateways');
    expect(prepared.digest.intro).toBe('Fast, faster');
  });

  it('cleans every text field of every item', () => {
    const [first, ...rest] = makeItems(3);
    const dirty = makeDigestItem(first!, {
      title: `A ${EM_DASH} B`,
      area: `C ${EM_DASH} D`,
      summary: `E ${EM_DASH} F`,
      whyItMatters: `G ${EM_DASH} H`,
    });
    const items = [dirty, ...rest.map((item) => makeDigestItem(item))];

    const [item] = prepareDraft({ writer: 'w', digest: makeDigest([], { items }) }, 5, []).digest
      .items;

    expect(item).toMatchObject({
      title: 'A, B',
      area: 'C, D',
      summary: 'E, F',
      whyItMatters: 'G, H',
    });
  });
});
