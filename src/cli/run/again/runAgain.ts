import type { AppHandle } from '../../../app/container';
import type { DeliveryId } from '../../../delivery/deliveryId';
import type { LoadedConfig } from '../../../config/load';
import type { DigestDeps, RunOptions, RunResult } from '../../../digest/types';
import { variantLabel, type RunVariant } from '../../../digest/variant';
import { ExitCode } from '../../../domain/schemas';
import { errorMessage } from '../../../shared/errors';
import { isPromptCancelled } from '../../init/io/inquirerPrompts';
import { saveLocalCopy } from '../summary/localCopy';
import { reportRun } from '../summary/report';
import type { Reporter } from '../summary/summary';
import { confirmSend, sendChannelIds, sendVariant } from './sendConfirm';
import type { RunPrompts } from './types';

/** What a second run needs besides the app. */
export interface AgainRunIo {
  runDigest: (deps: DigestDeps, options: RunOptions) => Promise<RunResult>;
  prompts: RunPrompts;
  interactive: boolean;
  report: Reporter;
}

export interface AgainRunPlan {
  loaded: LoadedConfig;
  reuse: NonNullable<RunOptions['reuse']>;
  variant: RunVariant;
  sinceDays: number | undefined;
  dryRun: boolean | undefined;
}

/** Whether to send: asked in a terminal, otherwise a variant flag was the answer. */
async function wantsSend(io: AgainRunIo, ids: readonly DeliveryId[]): Promise<boolean> {
  if (!io.interactive) return true;
  try {
    return await confirmSend(io.prompts, ids);
  } catch (error) {
    if (!isPromptCancelled(error)) throw error;
    io.report.err('Cancelled. Nothing was sent.\n');
    return false;
  }
}

/**
 * A second run of a week: build the variant digest without sending (phase A), write its postfixed
 * files, print the summary, then send it to the non-Markdown channels if the user says so (phase B).
 * Exit code: the build's, or 1 when the file copy or a send failed.
 */
export async function runAgain(
  app: AppHandle,
  io: AgainRunIo,
  plan: AgainRunPlan,
): Promise<number> {
  const { variant } = plan;
  const result = await io.runDigest(app.deps, {
    sinceDays: plan.sinceDays,
    dryRun: true,
    force: true,
    reuse: plan.reuse,
    variant,
  });
  const { message } = result;
  const copy = message ? await saveLocalCopy(app, message) : { written: false };
  const dir = await reportRun(io.report, plan.loaded, result, copy, variant);
  if (!message) {
    io.report.err(
      `No ${variantLabel(variant)} digest was built (status: ${result.record.status}).\n`,
    );
    return result.exitCode;
  }
  let code: number = result.exitCode;
  if (copy.error !== undefined) {
    io.report.err(
      `Error: could not write the ${variantLabel(variant)} digest to ${dir}: ${copy.error}\n`,
    );
    code = ExitCode.Failed;
  }
  const ids = sendChannelIds(app);
  if (plan.dryRun === true || ids.length === 0 || !(await wantsSend(io, ids))) return code;
  const sent = await sendVariant(app, message, variant, result.record.runId);
  if (sent.error === undefined) {
    io.report.out(`Sent to ${ids.join(', ')}.\n`);
    return code;
  }
  const missed = ids.filter((id) => !sent.deliveredTo.includes(id));
  const where = missed.length > 0 ? ` Not sent to: ${missed.join(', ')}.` : '';
  io.report.err(`Error: ${errorMessage(sent.error)}.${where} Run it again to retry.\n`);
  return ExitCode.Failed;
}
