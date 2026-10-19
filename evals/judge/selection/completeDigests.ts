import { DigestError } from '../../../src/shared/errors';
import type { GradedDigest, GradingSheet } from '../gradingSheet';
import type { CompleteDigest } from './types';

/** The fields of a digest that are still null, in the order the maintainer fills them. */
export function missingFields(digest: GradedDigest): string[] {
  const fields = ['week', 'writer', 'humanGrade', 'judgeScore'] as const;
  return fields.filter((field) => digest[field] === null);
}

/**
 * Every row of the sheet with its week, writer, grade and score filled in. Throws a DigestError
 * that lists each incomplete row and what it lacks, so a half-filled sheet never yields a number.
 */
export function completeDigests(sheet: GradingSheet): CompleteDigest[] {
  const incomplete = sheet.digests.flatMap((digest) => {
    const missing = missingFields(digest);
    return missing.length > 0 ? [`${digest.id} (${missing.join(', ')})`] : [];
  });
  if (incomplete.length > 0) {
    throw new DigestError(
      `The grading sheet is still missing values: ${incomplete.join(', ')}. ` +
        'Fill them in, or delete the rows you do not grade.',
    );
  }
  return sheet.digests.flatMap(({ id, week, writer, humanGrade, judgeScore }) =>
    week === null || writer === null || humanGrade === null || judgeScore === null
      ? []
      : [{ id, week, writer, humanGrade, judgeScore }],
  );
}
