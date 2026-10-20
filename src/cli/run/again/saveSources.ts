import { basename } from 'node:path';
import { ConfigSchema, type ConfigInput } from '../../../config/schema';
import type { Source } from '../../../domain/schemas';
import { DigestError, errorMessage } from '../../../shared/errors';
import { toJson } from '../../init/configFile/configFile';
import type { FileIo, RunPrompts } from './types';

/** `Save to digest.config.json for future weeks?` Default no: a run's sources are for this run. */
export function confirmSave(prompts: RunPrompts, configPath: string): Promise<boolean> {
  return prompts.confirm({
    message: `Save to ${basename(configPath)} for future weeks?`,
    default: false,
  });
}

function parseObject(text: string, configPath: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DigestError(`${basename(configPath)} is not valid JSON: ${errorMessage(error)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DigestError(`${basename(configPath)} must hold a JSON object`);
  }
  return Object.fromEntries(Object.entries(raw));
}

/**
 * Adds `added` to the config file's `sources`, keeping every other key. When the file has no
 * `sources` of its own, `current` (the defaults it runs with) are written first. The result must
 * pass `ConfigSchema` before anything is written.
 */
export async function saveSources(
  configPath: string,
  added: readonly Source[],
  current: readonly Source[],
  io: FileIo,
): Promise<void> {
  const text = await io.readFile(configPath);
  if (text === undefined) throw new DigestError(`${configPath} does not exist`);
  const raw = parseObject(text, configPath);
  const own = Array.isArray(raw.sources) ? (raw.sources as unknown[]) : current;
  const next = { ...raw, sources: [...own, ...added] };
  const checked = ConfigSchema.safeParse(next);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new DigestError(
      `${basename(configPath)} would not be valid with these sources: ${issue?.message ?? 'unknown problem'}`,
    );
  }
  await io.writeFile(configPath, toJson(next as ConfigInput));
}
