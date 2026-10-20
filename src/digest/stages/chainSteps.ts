import type { RunContext } from '../chain/runContext';
import { stage } from '../chain/stage';
import type { ChainState } from '../chain/state';
import type { WorkflowStep } from '../workflow';
import { classify } from './classify';
import { collect } from './collect';
import { deliver } from './deliver';
import { guardCandidates } from './guardCandidates';
import { guardInput } from './guardInput';
import { guardOutput } from './guardOutput';
import { processItems } from './processItems';
import { selectWinner } from './selectWinner';
import { write } from './write';

/** The chain in order; a dry run stops after `select` and never delivers. */
export function chainSteps(ctx: RunContext): WorkflowStep<ChainState>[] {
  const steps = [
    stage(ctx, 'collect', collect),
    stage(ctx, 'guardInput', guardInput),
    stage(ctx, 'classify', classify),
    stage(ctx, 'process', processItems),
    stage(ctx, 'guardCandidates', guardCandidates),
    stage(ctx, 'write', write),
    stage(ctx, 'guardOutput', guardOutput),
    stage(ctx, 'select', selectWinner),
  ];
  return ctx.dryRun ? steps : [...steps, stage(ctx, 'deliver', deliver)];
}
