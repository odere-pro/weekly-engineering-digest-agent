import { GuardsConfigSchema } from '../../src/config/schema';
import type { DigestDeps } from '../../src/digest/types';
import type { Draft } from '../../src/domain/schemas';
import type { GuardCheckId } from '../../src/guards/guardVerdict';
import { guardOutputStep } from '../../src/guards/guardOutput';
import type { GroundingOutcome } from '../metrics/guards/groundedness';
import type { GuardTally } from '../metrics/guards/guardFalseBlocks';
import {
  flaggedChecks,
  recordOutputGuards,
  tallyOf,
  type OutputVerdict,
} from '../replay/guardVerdicts';
import { withoutItem, type GroundingCase } from '../schema';

export interface GroundingResults {
  outcomes: GroundingOutcome[];
  /** False blocks of the output guards on the clean control drafts. */
  tallies: Partial<Record<GuardCheckId, GuardTally>>;
  /** Output checks that did not run (switched off or no guard supplied). */
  disabledChecks: GuardCheckId[];
}

/** Each planted draft goes through the output guards together with its clean control. */
export async function checkGrounding(
  app: DigestDeps,
  cases: readonly GroundingCase[],
): Promise<GroundingResults> {
  const log: OutputVerdict[] = [];
  const config = GuardsConfigSchema.parse({}).output;
  const guardDeps = {
    guards: recordOutputGuards(app.outputGuards, log),
    config,
    logger: app.logger,
  };
  const outcomes: GroundingOutcome[] = [];
  const controls: Draft[] = [];
  let disabledChecks: GuardCheckId[] = [];
  for (const c of cases) {
    const control = withoutItem(c.draft, c.plantedItemId);
    if (control) controls.push(control);
    const { rejected, disabledChecks: disabled } = await guardOutputStep(
      control ? [c.draft, control] : [c.draft],
      c.sources,
      guardDeps,
    );
    disabledChecks = disabled;
    outcomes.push({
      caseId: c.id,
      caught: rejected.some((r) => r.draft === c.draft),
      flaggedBy: flaggedChecks(log.filter((v) => v.draft === c.draft).map((v) => v.verdict)),
    });
  }
  const controlVerdicts = log.filter((v) => controls.includes(v.draft)).map((v) => v.verdict);
  return { outcomes, tallies: tallyOf(controlVerdicts), disabledChecks };
}
