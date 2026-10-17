// `digest fetch` (W8-06). Stub with its final signature; W8-06 implements it.
export interface FetchCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Only these source ids; all enabled sources when absent. */
  source?: string[];
  since?: string;
  out?: string;
}

/** Returns the process exit code. */
export function fetchCommand(options: FetchCommandOptions): Promise<number> {
  process.stderr.write(
    `digest fetch is not implemented yet; config ${options.config ?? 'digest.config.json'}\n`,
  );
  return Promise.resolve(1);
}
