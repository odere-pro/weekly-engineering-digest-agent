/** How many errors of a `cause` chain are read: a chain can be long, or loop back on itself. */
export const MAX_CAUSE_DEPTH = 5;

/**
 * The error and then each `cause` after it, outermost first, while the cause is an `Error`.
 * Stops at `MAX_CAUSE_DEPTH` errors, so a loop in the chain ends. Anything that is not an `Error`
 * gives an empty list or ends the chain.
 */
export function causeChain(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && chain.length < MAX_CAUSE_DEPTH;) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}
