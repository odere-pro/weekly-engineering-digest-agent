/**
 * Runs `fn` over `inputs`, at most `limit` at a time; results keep the input order. `limit` must
 * be at least 1: with 0 nothing runs and the results are empty slots.
 */
export async function mapWithConcurrency<T, R>(
  inputs: readonly T[],
  limit: number,
  fn: (input: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(inputs.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const index = nextIndex++;
      results[index] = await fn(inputs[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, () => worker()));
  return results;
}
