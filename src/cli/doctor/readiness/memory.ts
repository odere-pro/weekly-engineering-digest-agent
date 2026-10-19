// RAM figures shared with `digest init` (imported by `init/prompts/profile.ts`) and the readiness table.

export const GIB = 1024 ** 3;
const QUALITY_MIN_RAM_GIB = 32;
/**
 * Where `quality` stops being tight. Measured only at 32 GiB (2026-10-19, M1 Pro: the biggest model
 * held 18-26 GB resident and the machine swapped); 48 GiB is an estimate, not a measurement.
 */
const QUALITY_HEADROOM_RAM_GIB = 48;
const LIGHT_MIN_RAM_GIB = 16;
/** Nothing in any profile runs below this: `light` is the smallest set. Used where RAM is not measured. */
const RAM_FLOOR_GIB = LIGHT_MIN_RAM_GIB;
/** A "32 GB" machine reports less (a Linux box about 31 GiB): the kernel keeps some for itself. */
const RAM_TOLERANCE = 0.05;

/** A row of the readiness table: a profile, or the untuned fallback used off Apple silicon. */
export type RowName = 'quality' | 'fast' | 'light' | 'fallback';
/** `maybe`: at least the 16 GiB floor, but the profile's real need is not measured. */
export type RamFit = 'yes' | 'no' | 'maybe';

const MEASURED_RAM_GIB: Readonly<Partial<Record<RowName, number>>> = {
  quality: QUALITY_MIN_RAM_GIB,
  light: LIGHT_MIN_RAM_GIB,
};

/** Whether `totalMemoryBytes` covers `requiredGiB`, less a 5% tolerance. */
export function hasRam(totalMemoryBytes: number, requiredGiB: number): boolean {
  return totalMemoryBytes >= requiredGiB * GIB * (1 - RAM_TOLERANCE);
}

/** Whether `quality` fits in this much RAM: 32 GiB, less a 5% tolerance. */
export function hasQualityMemory(totalMemoryBytes: number): boolean {
  return hasRam(totalMemoryBytes, QUALITY_MIN_RAM_GIB);
}

/** Whether `quality` has room to spare: 48 GiB (an estimate, see above), less a 5% tolerance. */
export function hasQualityHeadroom(totalMemoryBytes: number): boolean {
  return hasRam(totalMemoryBytes, QUALITY_HEADROOM_RAM_GIB);
}

export function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

export function fitsRam(name: RowName, totalMemoryBytes: number): RamFit {
  const measured = MEASURED_RAM_GIB[name];
  if (measured !== undefined) return hasRam(totalMemoryBytes, measured) ? 'yes' : 'no';
  return hasRam(totalMemoryBytes, RAM_FLOOR_GIB) ? 'maybe' : 'no';
}
