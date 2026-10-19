import { exitCodeFor } from '../../domain/schemas';
import type { RunContext } from '../chain/runContext';
import { resumeDelivery, type PartDelivery } from '../resume/resumeDelivery';
import type { RunResult } from '../types';

/** A resume sends the saved digest only; its record keeps the previous run's results. */
export async function resumed(ctx: RunContext, part: PartDelivery): Promise<RunResult> {
  const { record, markdown } = await resumeDelivery(ctx, part);
  return { record, exitCode: exitCodeFor(record.status), markdown };
}
