/** Spec: score 10 items per call when the classifier generates JSON. The rescore pass reuses it. */
export const BATCH_SIZE = 10;
/** The top of the relevance scale; a generated or rescored relevance is an integer 0..this. */
export const MAX_RELEVANCE = 3;
/** A generated tag carries no probability, so the chosen area counts as certain. */
export const GENERATED_AREA_CONFIDENCE = 1;
/** Classification answers are short tags; keep them deterministic. */
export const GENERATE_TEMPERATURE = 0;
