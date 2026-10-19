import { describe, expect, it } from 'vitest';
import { MAX_PROBLEM_CHARS, OutcomeNotesSchema, problemLines } from './problemLines';

describe('problemLines', () => {
  it('prints nothing when the file has no rejections and no failures', () => {
    expect(problemLines({})).toBe('');
    expect(problemLines({ failures: [], rejections: [] })).toBe('');
  });

  it('lists every problem of a rejection under the writer, rejections before failures', () => {
    const notes = {
      failures: [{ writer: 'writer-b', error: 'model timed out' }],
      rejections: [
        {
          writer: 'writer-c',
          attempt: 1,
          rejectedBy: ['linkCheck'],
          problems: ['dead link', 'missing summary'],
        },
      ],
    };
    expect(problemLines(notes)).toBe(
      [
        '',
        'Problems:',
        '  writer-c: dead link',
        '  writer-c: missing summary',
        '  writer-b: model timed out',
        '',
      ].join('\n'),
    );
  });

  it('says "failed" for a failure that has no error text', () => {
    expect(problemLines({ failures: [{ writer: 'writer-b' }] })).toBe(
      '\nProblems:\n  writer-b: failed\n',
    );
  });

  it('cuts a long problem or error to the problem width', () => {
    const long = 'x'.repeat(MAX_PROBLEM_CHARS * 2);
    const cut = `${'x'.repeat(MAX_PROBLEM_CHARS - 3)}...`;
    const text = problemLines({
      failures: [{ writer: 'w1', error: long }],
      rejections: [{ writer: 'w2', rejectedBy: ['formatCheck'], problems: [long] }],
    });
    expect(text).toBe(`\nProblems:\n  w2: ${cut}\n  w1: ${cut}\n`);
  });
});

describe('OutcomeNotesSchema', () => {
  it('reads failures and rejections from the drafts file and ignores the other keys', () => {
    const parsed = OutcomeNotesSchema.parse({
      drafts: [],
      failures: [{ writer: 'a', error: 'boom' }],
      rejections: [{ writer: 'b', rejectedBy: ['linkCheck'], problems: ['dead link'] }],
    });
    expect(parsed.failures).toEqual([{ writer: 'a', error: 'boom' }]);
    expect(parsed.rejections).toEqual([
      { writer: 'b', rejectedBy: ['linkCheck'], problems: ['dead link'] },
    ]);
  });

  it('drops a list that has the wrong shape instead of failing the whole file', () => {
    const parsed = OutcomeNotesSchema.parse({ failures: 'nope', rejections: [{ writer: 1 }] });
    expect(parsed.failures).toBeUndefined();
    expect(parsed.rejections).toBeUndefined();
  });

  it('accepts a file that has neither list', () => {
    expect(OutcomeNotesSchema.parse({ drafts: [] })).toEqual({});
  });
});
