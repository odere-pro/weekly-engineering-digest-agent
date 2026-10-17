// `digest eval` measures the two source metrics from evals/sources, before any model call.
import { describe, expect, it } from 'vitest';
import { loadEvalCases, runEval } from '../../../evals/runEval.js';
import type { SourceFetcherFactories } from '../../../evals/sourceEval.js';
import { itemIdFor } from '../../../src/shared/url.js';
import { makeItem } from '../../builders.js';
import { FakeSourceFetcher } from '../../fakes/FakeSourceFetcher.js';
import { NONE, makeApp, makeDeps, useCasesDir, writeJson, writeStandardWeeks } from './evalKit.js';

const root = useCasesDir();
const LONG = 'A summary that is comfortably longer than forty characters.';
const URL_1 = 'https://openai.com/news/one';

const item = (summary: string) =>
  makeItem({ id: itemIdFor(URL_1), sourceId: 'openai-news', url: URL_1, summary });

async function writeRecording(): Promise<void> {
  await writeJson(root(), 'sources/openai-news/response.json', {
    url: 'https://openai.com/news/rss.xml',
    status: 200,
    contentType: 'application/rss+xml',
    fetchedAt: '2026-10-17T08:00:00.000Z',
    bodyFile: 'body.xml',
  });
  await writeJson(root(), 'sources/openai-news/expected.json', {
    reviewed: true,
    entryCount: 1,
    items: [item(LONG)],
  });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(`${root()}/sources/openai-news/body.xml`, '<rss/>');
}

const factories = (returned: ReturnType<typeof item>[]): SourceFetcherFactories => ({
  rss: () => new FakeSourceFetcher('rss', { 'openai-news': returned }),
  github: () => new FakeSourceFetcher('github', {}),
});

describe('runEval with source recordings', () => {
  it('loads the recordings with the other cases', async () => {
    await writeStandardWeeks(root());
    await writeRecording();

    const cases = await loadEvalCases(root());

    expect(cases.sources.map((s) => s.source.id)).toEqual(['openai-news']);
  });

  it('reports parse yield, summary fill per source and the sources count', async () => {
    await writeStandardWeeks(root());
    await writeRecording();
    const deps = makeDeps(makeApp(), [], {}, { sourceFetchers: factories([item('short')]) });

    const card = await runEval({ profile: 'quality', casesDir: root(), minimums: NONE }, deps);

    expect(card.counts.sources).toBe(1);
    expect(card.metrics.sourceParse).toMatchObject({
      value: 1,
      pass: true,
      detail: { 'openai-news': 1 },
    });
    expect(card.metrics.sourceSummaryFill).toMatchObject({
      value: 0,
      pass: false,
      detail: { 'openai-news': 0 },
    });
    expect(card.metrics.sourceSummaryFill.gate.kind).toBe('soft');
  });

  it('leaves the source metrics unmeasured when nothing is recorded', async () => {
    await writeStandardWeeks(root());
    const deps = makeDeps(makeApp(), []);

    const card = await runEval({ profile: 'quality', casesDir: root(), minimums: NONE }, deps);

    expect(card.counts.sources).toBe(0);
    expect(card.metrics.sourceParse).toMatchObject({ value: null, pass: null });
  });
});
