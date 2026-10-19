import { describe, expect, it } from 'vitest';
import { buildRetryPrompt } from './writePrompt';
import type { DigestItem } from '../domain/schemas';
import type { ScoredItem } from '../classify/classification';
import { retryStep, writeStep, type WriteDeps } from './write';
import type { GenerateRequest } from '../models/ModelProvider';
import { UNTRUSTED_DATA_RULE } from '../shared/untrusted';
import type { Logger } from '../shared/telemetry';
import { makeDigestItem, makeScoredItem } from '../../test/builders';
import { FakeModelProvider, noopLogger } from '../../test/fakes';

const WEEK_ID = '2026-W42';
const FOCUS_AREAS = ['AI models and tooling', 'Platform engineering'] as const;

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
  // The writer schema requires urgency and action since W8-01.
  return body(
    items.map((item) =>
      makeDigestItem(item, { urgency: 'worth-a-look', action: 'Relevant if you run it.' }),
    ),
  );
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
