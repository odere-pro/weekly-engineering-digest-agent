/** One labeled observation the fit learns from. */
export interface Sample {
  /** The decider's raw relevance. */
  raw: number;
  area: string;
  /** The label's relevance, 0-3. */
  target: number;
}
