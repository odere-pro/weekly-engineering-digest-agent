// `digest preview` (W8-07). Stub with its final signature; W8-07 implements it.
export interface PreviewCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  week: string;
  channel?: string;
  out?: string;
}

/** Returns the process exit code. */
export function previewCommand(options: PreviewCommandOptions): Promise<number> {
  process.stderr.write(
    `digest preview is not implemented yet; config ${options.config ?? 'digest.config.json'}\n`,
  );
  return Promise.resolve(1);
}
