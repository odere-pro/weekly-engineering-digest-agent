import type { CompleteDigest } from './types';

/** Judge scores closer than this are a tie; the same bar the select step uses. */
export const SCORE_TIE_EPSILON = 1e-9;

/** The writer with the highest judge score; '' on a tie, as the judge then shows no preference. */
export function judgePick(drafts: readonly CompleteDigest[]): string {
  const top = Math.max(...drafts.map((d) => d.judgeScore));
  const leaders = drafts.filter((d) => top - d.judgeScore <= SCORE_TIE_EPSILON);
  return leaders.length === 1 ? (leaders[0]?.writer ?? '') : '';
}
