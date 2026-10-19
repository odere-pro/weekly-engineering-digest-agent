import { PROFILES } from '../../../src/config/profiles';

export const MODELS_AREA = 'AI models and tooling';
export const PLATFORM_AREA = 'Platform engineering';
export const PROFILE = PROFILES.quality;

function writerAt(index: number): string {
  const writer = PROFILE.writers[index];
  if (writer === undefined) throw new Error(`The ${PROFILE.name} profile has no writer ${index}`);
  return writer;
}
export const FIRST_WRITER = writerAt(0);
export const SECOND_WRITER = writerAt(1);
export const OLLAMA_URL = 'http://localhost:11434';

/** A Friday in ISO week 2026-W42 (Europe/Berlin), after Monday's 07:45 slot. */
export const FRIDAY = '2026-10-16T05:45:00Z';
export const WEEK = '2026-W42';

/** Generous for a real 1 s retry backoff or a 1.5 s feed backoff on a loaded machine. */
export const TEST_TIMEOUT_MS = 15_000;
