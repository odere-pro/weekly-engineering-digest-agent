/** Arithmetic mean; NaN for no values, so callers check for an empty list first. */
export const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
