// `digest show` (W8-07). Stub with its final signature; W8-07 implements it.
export interface ShowCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  week: string;
  part?: string;
  json?: boolean;
}

/** Returns the process exit code. */
export function showCommand(options: ShowCommandOptions): Promise<number> {
  process.stderr.write(
    `digest show is not implemented yet; config ${options.config ?? 'digest.config.json'}\n`,
  );
  return Promise.resolve(1);
}
