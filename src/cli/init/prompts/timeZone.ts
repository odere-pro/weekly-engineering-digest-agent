import type { InitIo } from '../types';

/** What a container reports when TZ is not set. */
const CONTAINER_DEFAULT_ZONES: ReadonlySet<string> = new Set(['UTC', 'Etc/UTC']);

export function isContainerDefaultZone(timeZone: string): boolean {
  return CONTAINER_DEFAULT_ZONES.has(timeZone);
}

/** The default is where this process runs; in a container that is UTC unless TZ is set. */
export async function askTimeZone(io: InitIo, inDocker: boolean): Promise<string> {
  const containerOnUtc = inDocker && isContainerDefaultZone(io.timeZone);
  const hint = containerOnUtc
    ? ' (the container runs on UTC unless TZ is set; enter your own zone, e.g. Europe/Berlin)'
    : '';
  const zone = await io.prompts.input({
    message: `Time zone for the weekly schedule${hint}`,
    default: io.timeZone,
    validate: (value) => isTimeZone(value.trim()) || 'Enter an IANA time zone, e.g. Europe/Berlin',
  });
  return zone.trim();
}

/** True for a name `Intl` knows as an IANA zone ("Europe/Berlin", "UTC"). */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value !== '';
  } catch {
    return false;
  }
}
