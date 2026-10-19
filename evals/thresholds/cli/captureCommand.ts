// `capture`: calls the models once per subject and saves the raw outputs.
import { join } from 'node:path';
import { z } from 'zod';
import { DigestError } from '../../../src/shared/errors';
import { captureRaw } from '../capture/captureRaw';
import { RawCaptureSchema, failedCalls, totalFailed, type RawCapture } from '../capture/schemas';
import { assertNew, localDate, writeJson } from './files';
import { EXIT_FAILED, EXIT_OK, type CliIo } from './io';

export interface CaptureOptions {
  config: string | undefined;
  force: boolean;
}

/** Saves the capture, then exits 1 if it is invalid or any call failed: the file is kept either way. */
async function saveCapture(
  raw: RawCapture,
  path: string,
  io: CliIo,
  force: boolean,
): Promise<number> {
  await writeJson(path, raw, force);
  io.stdout(`Saved ${path}\n`);
  const parsed = RawCaptureSchema.safeParse(raw);
  if (!parsed.success)
    throw new DigestError(`${path} is not a valid raw capture:\n${z.prettifyError(parsed.error)}`);
  const failures = totalFailed(raw);
  if (failures === 0) return EXIT_OK;
  io.stderr(`${failures} model calls failed: ${JSON.stringify(failedCalls(raw))}\n`);
  return EXIT_FAILED;
}

export async function captureCommand(options: CaptureOptions, io: CliIo): Promise<number> {
  const session = await io.openCapture(options.config);
  try {
    const capturedAt = io.clock.now().toISOString();
    const path = join(io.outDir, 'raw', `${localDate(capturedAt)}-${session.profile}.json`);
    if (!options.force) await assertNew(path);
    const set = await io.loadEvalSet(io.casesDir);
    io.stderr(`Capturing ${session.profile}: ${JSON.stringify(session.models)}\n`);
    const data = await captureRaw(set, {
      ...session.deps,
      clock: io.clock,
      progress: (line) => {
        io.stderr(`${line}\n`);
      },
    });
    const raw: RawCapture = {
      profile: session.profile,
      capturedAt,
      ollamaVersion: session.ollamaVersion,
      models: session.models,
      focusAreas: [...session.deps.focusAreas],
      baseline: session.baseline,
      ...data,
    };
    return await saveCapture(raw, path, io, options.force);
  } finally {
    await session.close();
  }
}
