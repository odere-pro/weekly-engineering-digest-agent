import { describe, expect, it } from 'vitest';
import type { SourceAnswer } from '../../../sources/adapters/pipeline';
import { createRecorder } from './recorder';

const answer = (sourceId: string, status: number): SourceAnswer => ({
  sourceId,
  url: `https://example.com/${sourceId}.xml`,
  status,
  contentType: 'application/rss+xml',
  body: `<rss status="${status}"/>`,
});

describe('createRecorder', () => {
  it('gives nothing for a source that was never heard from', () => {
    const recorder = createRecorder();

    expect(recorder.answers('unknown')).toEqual([]);
    expect(recorder.entries('unknown')).toBeUndefined();
  });

  it("keeps a source's answers in the order they came", () => {
    const recorder = createRecorder();

    recorder.tap.answer(answer('a', 301));
    recorder.tap.answer(answer('a', 200));

    expect(recorder.answers('a').map((event) => event.status)).toEqual([301, 200]);
  });

  it('keeps the sources apart', () => {
    const recorder = createRecorder();

    recorder.tap.answer(answer('a', 200));
    recorder.tap.answer(answer('b', 500));
    recorder.tap.entries({ sourceId: 'a', parsed: 4, skipped: 1 });

    expect(recorder.answers('a').map((event) => event.status)).toEqual([200]);
    expect(recorder.answers('b').map((event) => event.status)).toEqual([500]);
    expect(recorder.entries('a')).toEqual({ sourceId: 'a', parsed: 4, skipped: 1 });
    expect(recorder.entries('b')).toBeUndefined();
  });

  it('keeps the last entry count of a source', () => {
    const recorder = createRecorder();

    recorder.tap.entries({ sourceId: 'a', parsed: 4, skipped: 1 });
    recorder.tap.entries({ sourceId: 'a', parsed: 6, skipped: 0 });

    expect(recorder.entries('a')).toEqual({ sourceId: 'a', parsed: 6, skipped: 0 });
  });

  it('does not change a list it handed out earlier', () => {
    const recorder = createRecorder();
    recorder.tap.answer(answer('a', 200));
    const before = recorder.answers('a');

    recorder.tap.answer(answer('a', 201));

    expect(before).toHaveLength(1);
    expect(recorder.answers('a')).toHaveLength(2);
  });

  it('is empty for each new recorder', () => {
    const first = createRecorder();
    first.tap.answer(answer('a', 200));

    expect(createRecorder().answers('a')).toEqual([]);
  });
});
