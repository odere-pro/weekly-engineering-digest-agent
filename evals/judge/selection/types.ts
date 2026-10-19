/** A sheet row with every field filled in: what the statistics and the selection can read. */
export interface CompleteDigest {
  id: string;
  week: string;
  writer: string;
  humanGrade: number;
  judgeScore: number;
}

/** The writer the maintainer picked in a week, and the writer the judge scored highest ('' for none). */
export interface Selection {
  human: string;
  judge: string;
}
