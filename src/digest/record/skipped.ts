import { exitCodeFor } from '../../domain/schemas';
import type { RunContext } from '../chain/runContext';
import { EMPTY_STATE } from '../chain/state';
import type { RunResult } from '../types';
import { buildRecord } from './buildRecord';

/** Saves nothing: the week's sent record stays as it is. */
export function skipped(ctx: RunContext): RunResult {
  ctx.logger.info('Week already has a sent digest; skipped (use --force to run it again)');
  const record = buildRecord(ctx, { state: EMPTY_STATE }, 'skipped', ctx.deps.clock.now());
  return { record, exitCode: exitCodeFor('skipped') };
}
