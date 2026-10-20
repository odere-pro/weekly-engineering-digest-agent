import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { writeCheckedStep } from '../../write/write';
import { PartialFailure } from '../chain/failures';
import type { RunContext } from '../chain/runContext';
import { perspectiveOf } from '../variant';
import type { ChainState, DraftsFile } from '../chain/state';
import { toJson } from '../ending/runFiles/runFiles';
import { rejected } from './draftOutcomes';
import { keepArtifact } from './keepArtifact';

const WRITE_FAILED = 'write';

/**
 * Every writer drafts the selected items; each draft gets its link and format check. A writer
 * that failed is recorded as rejected by `write`. No draft at all fails the step, keeping the
 * state so far.
 */
export async function write(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { model, profile, config } = ctx.deps;
  const { checked, writeFailures, retryFailures, rejections } = await writeCheckedStep(
    state.selected,
    {
      model,
      writers: profile.writers,
      focusAreas: config.focusAreas,
      weekId: ctx.weekId,
      logger,
      collected: state.collected,
      disabledGuards: ctx.disabledGuards,
      topN: config.topN,
      ...perspectiveOf(ctx),
      signal: ctx.signal,
    },
  );
  const written = checked.map((entry) => entry.draft);
  const failures = [
    ...writeFailures,
    ...retryFailures.map((failure) => ({ ...failure, retry: true })),
  ];
  const draftsFile: DraftsFile = { drafts: written, failures, rejections };
  const held = {
    ...(await keepArtifact(ctx, state, 'drafts.json', toJson(draftsFile))),
    draftsFile,
  };
  const failed = writeFailures.map((failure) => rejected(failure.writer, [WRITE_FAILED]));
  const next = { ...held, checked, drafts: failed };
  if (written.length > 0) return next;
  // Names writers only: a writer's error can quote the model's reply. drafts.json has it.
  const writers = writeFailures.map((failure) => failure.writer).join(', ');
  const error = `Every writer failed: ${writers}; drafts.json has the reasons`;
  throw new PartialFailure(next, new DigestError(error, { step: 'write' }));
}
