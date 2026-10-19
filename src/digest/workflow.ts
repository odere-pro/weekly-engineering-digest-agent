// Runs the chain's steps in order. A plain loop: no framework (ADR 0001,
// docs/architecture/decisions/0001-mastra.md). Every decision lives in the steps and in runDigest.

/** One workflow step: a plain async function from state to the next state. */
export interface WorkflowStep<State> {
  readonly id: string;
  readonly run: (state: State) => Promise<State>;
}

/**
 * Runs `steps` in order, feeding each the state the previous one returned, and returns the last
 * state. State is handed over as it is. A step's error propagates unchanged, so a DigestError
 * keeps its class, exit code and step; the steps after it do not run.
 */
export async function runWorkflow<State>(
  _workflowId: string,
  steps: readonly WorkflowStep<State>[],
  input: State,
): Promise<State> {
  let state = input;
  for (const step of steps) state = await step.run(state);
  return state;
}
