// The thin Mastra layer (@mastra/core 1.78.0, pinned). It only chains plain step functions;
// every decision lives in the steps and in runDigest.
import { noopLogger } from '@mastra/core/logger';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

/** One workflow step: a plain async function from state to the next state. */
export interface WorkflowStep<State> {
  readonly id: string;
  readonly run: (state: State) => Promise<State>;
}

/** Mastra carries the state without looking at it: no validation, no serialization. */
const opaqueState = z.custom<unknown>();

/**
 * Runs `steps` in order as one Mastra workflow run and returns the last step's state.
 * A step's error is rethrown unchanged: Mastra would otherwise hand back a plain copy that
 * has lost its class, and with it a DigestError's exit code and step.
 */
export async function runWorkflow<State>(
  id: string,
  steps: readonly WorkflowStep<State>[],
  input: State,
): Promise<State> {
  const caught: { failure?: { error: unknown } } = {};
  const [first, ...rest] = steps.map((step) =>
    createStep({
      id: step.id,
      inputSchema: opaqueState,
      outputSchema: opaqueState,
      execute: async ({ inputData }) => {
        try {
          return await step.run(inputData as State);
        } catch (error) {
          caught.failure = { error };
          throw error;
        }
      },
    }),
  );
  if (!first) return input;

  const base = createWorkflow({ id, inputSchema: opaqueState, outputSchema: opaqueState });
  // Mastra logs step errors to the console; runDigest logs them through its own logger.
  // __setLogger is internal API: re-check it when the @mastra/core pin moves.
  base.__setLogger(noopLogger);
  const workflow = rest.reduce((chain, step) => chain.then(step), base.then(first)).commit();
  const result = await (await workflow.createRun()).start({ inputData: input });
  // Mastra hands back the object the last step returned; it is that step's State.
  if (result.status === 'success') return result.result as State;
  if (caught.failure) throw caught.failure.error;
  throw new Error(`Workflow ${id} ended with status "${result.status}"`);
}
