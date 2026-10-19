import { homedir, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { loadConfig } from '../../../config/load';
import { ProfileNameSchema } from '../../../config/schema';
import { EXIT_NONE_FIT, EXIT_OK } from '../report/exitCodes';
import { withoutUrlCredentials } from '../report/withoutUrlCredentials';
import type { RowName } from './memory';
import { buildRow } from './rows';
import { render } from './table';
import {
  askOllama,
  freeDiskBytes,
  localModelsDir,
  ollamaHealth,
  resolveTarget,
  type ReadinessIo,
} from './target';

export interface ReadinessCommandOptions {
  /** Path to digest.config.json; optional, readiness works without one. */
  config?: string;
}

const ROW_NAMES: readonly RowName[] = [...ProfileNameSchema.options, 'fallback'];

const defaultIo: ReadinessIo = {
  loadConfig: (options) => loadConfig(options),
  env: process.env,
  totalMemoryBytes: totalmem(),
  nodeVersion: process.version,
  homeDir: homedir(),
  freeDiskBytes,
  ollamaHealth,
  stdout: (text) => {
    process.stdout.write(text);
  },
};

/**
 * `digest doctor --readiness`: the machine summary and a verdict for every profile (W7-02).
 * Contacts only Ollama; no feed, no delivery endpoint. Exit 0 if one profile can run here (ready,
 * tight on RAM or needing only pulls), 1 if none can.
 */
export async function readinessCommand(
  options: ReadinessCommandOptions,
  overrides: Partial<ReadinessIo> = {},
): Promise<number> {
  const io: ReadinessIo = { ...defaultIo, ...overrides };
  const target = await resolveTarget(options.config, io);
  const health = await askOllama(target.ollamaUrl, io);
  const rows = ROW_NAMES.map((name) =>
    buildRow(name, target.platform, io.totalMemoryBytes, health),
  );
  const modelsDir = localModelsDir(target.ollamaUrl, io);
  const disk = {
    data: await io.freeDiskBytes(resolve(target.dataDir)),
    models: modelsDir === undefined ? undefined : await io.freeDiskBytes(modelsDir),
  };
  io.stdout(withoutUrlCredentials(render({ target, health, rows, io, modelsDir, disk })));
  return rows.some((row) => row.verdict !== 'not for this machine') ? EXIT_OK : EXIT_NONE_FIT;
}
