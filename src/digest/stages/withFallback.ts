import type { Logger } from '../../shared/telemetry';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { toJson } from '../ending/runFiles/runFiles';
import { buildFallback } from '../fallback';
import { keepArtifact } from './keepArtifact';

/** The template-only digest as the only passing draft, or undefined when it is off or failed. */
export async function withFallback(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState | undefined> {
  if (!ctx.useFallback) return undefined;
  const { config, outputGuards } = ctx.deps;
  const fallback = await buildFallback({
    selected: state.selected,
    collected: state.collected,
    weekId: ctx.weekId,
    topN: config.topN,
    disabledGuards: ctx.disabledGuards,
    outputGuards,
    guardConfig: config.guards.output,
    drafts: state.drafts,
    logger,
  });
  if (!fallback) return undefined;
  // The record names the fallback as winner, so drafts.json must hold its draft (preview, show).
  const file = { drafts: [], failures: [], rejections: [], ...state.draftsFile };
  const saved = await keepArtifact(
    ctx,
    state,
    'drafts.json',
    toJson({ ...file, drafts: [...file.drafts, fallback.winner.draft] }),
  );
  return {
    ...saved,
    drafts: [...state.drafts, fallback.outcome],
    passed: [fallback.winner],
    fallback: true,
  };
}
