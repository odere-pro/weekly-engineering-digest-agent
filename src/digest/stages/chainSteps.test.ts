import { describe, expect, it } from 'vitest';
import { chainSteps } from './chainSteps';
import { runWorkflow } from '../workflow';
import { contextFor, stateOf } from '../__fixtures__/stageKit';

const ALL = ['collect', 'guardInput', 'classify', 'process', 'write', 'guardOutput', 'select'];

describe('chainSteps', () => {
  it('lists the stages in pipeline order, ending with deliver', () => {
    const steps = chainSteps(contextFor().ctx);

    expect(steps.map((step) => step.id)).toEqual([...ALL, 'deliver']);
  });

  it('stops a dry run after select: it sends nothing', () => {
    const steps = chainSteps(contextFor({ dryRun: true }).ctx);

    expect(steps.map((step) => step.id)).toEqual(ALL);
  });

  it('skips every stage of a run that is already settled', async () => {
    const h = contextFor();
    const settled = stateOf({ settled: { status: 'quiet', note: 'no items collected' } });

    const end = await runWorkflow('digest', chainSteps(h.ctx), settled);

    expect(end).toBe(settled);
    expect(h.spans).toEqual([]);
  });
});
