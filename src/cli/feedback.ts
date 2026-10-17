// `digest feedback <week>`: the reader's ticks in review.md become eval labels (W7-07).
// Stub with the final signature; W7-07 fills it.
export interface FeedbackCommandOptions {
  week: string;
  config?: string;
}

/** Returns the process exit code. */
export function feedbackCommand(options: FeedbackCommandOptions): Promise<number> {
  process.stderr.write(`digest feedback ${options.week}: not implemented yet (W7-07)\n`);
  return Promise.resolve(1);
}
