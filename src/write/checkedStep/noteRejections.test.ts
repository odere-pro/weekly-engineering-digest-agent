import { describe, expect, it, vi } from 'vitest';
import type { Draft } from '../../domain/schemas';
import type { Logger } from '../../shared/telemetry';
import { noteRejections } from './noteRejections';
import type { CodeChecked } from './types';
import { MAX_PROBLEMS, PROBLEM_MAX_CHARS } from '../writePrompt';
import { makeDigest, makeItem } from '../../../test/builders';
import { noopLogger } from '../../../test/fakes';

function spyLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const logger: Logger = { ...noopLogger, warn, child: () => logger };
  return { logger, warn };
}

function entry(
  writer: string,
  rejectedBy: readonly string[] = [],
  problems: readonly string[] = [],
): CodeChecked {
  const draft: Draft = { writer, digest: makeDigest([makeItem()]) };
  return { draft, markdown: '', rejectedBy, problems };
}

describe('noteRejections', () => {
  it('returns one rejection per rejected draft, with the attempt, and logs each at warn', () => {
    const { logger, warn } = spyLogger();
    const checked = [
      entry('writer-a', ['linkCheck'], ['Unknown URL not in collected items: https://e.example/a']),
      entry('writer-b'),
      entry('writer-c', ['linkCheck', 'formatCheck'], ['Contains an em dash']),
    ];

    const rejections = noteRejections(logger, checked, 1);

    expect(rejections).toEqual([
      {
        writer: 'writer-a',
        attempt: 1,
        rejectedBy: ['linkCheck'],
        problems: ['Unknown URL not in collected items: https://e.example/a'],
      },
      {
        writer: 'writer-c',
        attempt: 1,
        rejectedBy: ['linkCheck', 'formatCheck'],
        problems: ['Contains an em dash'],
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, 'Draft failed the checks', rejections[0]);
    expect(warn).toHaveBeenNthCalledWith(2, 'Draft failed the checks', rejections[1]);
  });

  it('marks the attempt of a retry as 2', () => {
    const rejections = noteRejections(noopLogger, [entry('writer-a', ['formatCheck'], ['x'])], 2);

    expect(rejections[0]?.attempt).toBe(2);
  });

  it('returns nothing and logs nothing when every draft passed, or there are none', () => {
    const { logger, warn } = spyLogger();

    expect(noteRejections(logger, [entry('writer-a'), entry('writer-b')], 1)).toEqual([]);
    expect(noteRejections(logger, [], 1)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('bounds the problems: the first few, each cut short, and a count of the rest', () => {
    const many = Array.from({ length: MAX_PROBLEMS + 7 }, (_, i) => `Problem ${i}`);
    const long = `Unknown URL not in collected items: https://evil.example/${'x'.repeat(900)}`;
    const { logger, warn } = spyLogger();

    const [rejection] = noteRejections(
      logger,
      [entry('writer-a', ['linkCheck'], [long, ...many])],
      1,
    );

    const logged = rejection!.problems;
    expect(logged).toHaveLength(MAX_PROBLEMS + 1);
    expect(logged.slice(0, MAX_PROBLEMS).every((p) => p.length <= PROBLEM_MAX_CHARS)).toBe(true);
    expect(logged.at(-1)).toBe(`and ${many.length + 1 - MAX_PROBLEMS} more problems`);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ problems: logged });
  });

  it('keeps the first problems, which the format check puts first, in view', () => {
    const problems = [
      'Expected under 500 words, got 612',
      ...Array.from({ length: 9 }, (_, i) => `Link ${i}`),
    ];

    const [rejection] = noteRejections(
      noopLogger,
      [entry('writer-a', ['formatCheck'], problems)],
      1,
    );

    expect(rejection?.problems[0]).toBe('Expected under 500 words, got 612');
  });

  it('turns control characters in a problem into spaces, so a log cannot be forged', () => {
    const [rejection] = noteRejections(
      noopLogger,
      [entry('writer-a', ['linkCheck'], ['Unknown URL not in collected items: a\nb\u001b[31mc'])],
      1,
    );

    expect(rejection?.problems[0]).toBe('Unknown URL not in collected items: a b [31mc');
  });
});
