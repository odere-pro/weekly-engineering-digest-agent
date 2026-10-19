import { describe, expect, it } from 'vitest';
import { row, sheetOf } from '../__fixtures__/sheetKit';
import { DigestError } from '../../../src/shared/errors';
import { GradedDigestSchema } from '../gradingSheet';
import { completeDigests, missingFields } from './completeDigests';

describe('missingFields', () => {
  const digest = (overrides: Record<string, unknown>) =>
    GradedDigestSchema.parse({
      ...row('d01', '2026-W01', 'a', 4, 4),
      ...overrides,
    });

  it('is empty for a complete row', () => {
    expect(missingFields(digest({}))).toEqual([]);
  });

  it('lists the null fields in the order the maintainer fills them', () => {
    expect(
      missingFields(digest({ week: null, writer: null, humanGrade: null, judgeScore: null })),
    ).toEqual(['week', 'writer', 'humanGrade', 'judgeScore']);
    expect(missingFields(digest({ judgeScore: null, writer: null }))).toEqual([
      'writer',
      'judgeScore',
    ]);
  });

  it('leaves the draft and the notes out: they are not needed to calibrate', () => {
    expect(missingFields(digest({ draft: null, notes: '' }))).toEqual([]);
  });
});

describe('completeDigests', () => {
  it('returns each row with its five fields', () => {
    const sheet = sheetOf([row('d01', '2026-W01', 'a', 4, 3.5), row('d02', '2026-W02', 'b', 2, 2)]);

    expect(completeDigests(sheet)).toEqual([
      { id: 'd01', week: '2026-W01', writer: 'a', humanGrade: 4, judgeScore: 3.5 },
      { id: 'd02', week: '2026-W02', writer: 'b', humanGrade: 2, judgeScore: 2 },
    ]);
  });

  it('keeps a grade of 0 as it is: only null is missing', () => {
    // The schema floors grades at 1, so a 0 can only come from a hand-built sheet.
    const sheet = sheetOf([row('d01', '2026-W01', 'a', 4, 4)]);
    const zero = { ...sheet, digests: sheet.digests.map((d) => ({ ...d, humanGrade: 0 })) };

    expect(completeDigests(zero)[0]?.humanGrade).toBe(0);
  });

  it('names every row that still misses a value, with the fields, in one DigestError', () => {
    const sheet = sheetOf([
      row('d01', '2026-W01', 'a', null, 4),
      row('d02', '2026-W01', 'b', 3, null),
      row('d03', '2026-W02', 'a', null, null),
      row('d04', '2026-W02', 'b', 3, 3),
    ]);

    const failure = () => completeDigests(sheet);

    expect(failure).toThrow(DigestError);
    expect(failure).toThrow(
      'The grading sheet is still missing values: d01 (humanGrade), d02 (judgeScore), ' +
        'd03 (humanGrade, judgeScore). Fill them in, or delete the rows you do not grade.',
    );
  });

  it('counts a row without a week or a writer as incomplete', () => {
    const sheet = sheetOf([
      { ...row('d01', '2026-W01', 'a', 4, 4), week: null },
      { ...row('d02', '2026-W01', 'b', 3, 3), writer: null },
    ]);

    expect(() => completeDigests(sheet)).toThrow('d01 (week), d02 (writer)');
  });

  it('does not change the sheet it was given', () => {
    const sheet = sheetOf([row('d01', '2026-W01', 'a', 4, 4)]);
    const before = structuredClone(sheet);

    completeDigests(sheet);

    expect(sheet).toEqual(before);
  });
});
