import { ProfileNameSchema, type ProfileName } from '../../../config/schema';
import { fitsRam, formatGiB, QUALITY_TIGHT_RAM } from '../../doctor/readiness/memory';
import type { Host, InitIo } from '../types';

/** `light` is the 16 GB profile only where the tuned models run (a Mac with Apple silicon). */
const LIGHT_OFF_MAC =
  'Off a Mac with Apple silicon it uses the larger fallback models, which need much more than 16 GB; "digest doctor" shows what this machine gets.';

export const QUALITY_UNMEASURED =
  'quality is not measured end to end yet: on the reference laptop (M1 Pro, 32 GB) its input guard alone took about 1 h for 147 items';

export const PROFILE_DESCRIPTIONS: Readonly<Record<ProfileName, string>> = {
  quality: `Two writers and a judge. Best output expected, but ${QUALITY_UNMEASURED}. At least 32 GB RAM (48 GB or more is comfortable) and about 66 GB of disk for the models.`,
  fast: 'One writer, no judge. Faster runs.',
  light: 'Smallest models. Fits in 16 GB of RAM.',
};

/**
 * Asks which model profile to use, with `recommended` as the default. A profile's text says
 * what it needs; `quality` also says when this machine is short of RAM, `light` when the
 * machine that runs Ollama has no Apple silicon.
 */
export async function askProfile(
  io: InitIo,
  host: Host,
  recommended: ProfileName,
): Promise<ProfileName> {
  const notes: Partial<Record<ProfileName, string>> = {
    ...((host.hostOs ?? io.platform) === 'darwin' ? {} : { light: LIGHT_OFF_MAC }),
    ...qualityNote(io, host.inDocker),
  };
  return io.prompts.select({
    message: 'Model profile',
    default: recommended,
    choices: ProfileNameSchema.options.map((profile) => ({
      name: profile === recommended ? `${profile} (recommended)` : profile,
      value: profile,
      description: [PROFILE_DESCRIPTIONS[profile], notes[profile]].filter(Boolean).join(' '),
    })),
  });
}

function qualityNote(io: InitIo, inDocker: boolean): { quality?: string } {
  const warning = qualityMemoryWarning(io, inDocker);
  return warning === undefined ? {} : { quality: warning };
}

/**
 * Says so when the RAM this process can see is short of what `quality` needs, or only just
 * enough: 32 GiB ran, but swapped (`QUALITY_TIGHT_RAM`, `fitsRam` says which). Inside Docker the figure is the
 * container's, not necessarily the machine's that runs Ollama, and the text names the limit when
 * there is one. The RAM figures live in `doctor/readiness/memory.ts`, so that
 * `digest doctor --readiness` and init cannot drift.
 */
export function qualityMemoryWarning(io: InitIo, inDocker: boolean): string | undefined {
  const limit = io.memoryLimitBytes ?? 0;
  const limited = limit > 0 && limit <= io.totalMemoryBytes;
  const seen = limited ? limit : io.totalMemoryBytes;
  const fit = fitsRam('quality', seen);
  if (fit === 'yes') return undefined;
  const amount = formatGiB(seen);
  const verdict =
    fit === 'tight'
      ? `, which is tight for quality: ${QUALITY_TIGHT_RAM}.`
      : '; quality needs about 32 GB.';
  if (!inDocker) return `This machine has ${amount} of RAM${verdict}`;
  if (limited) return `Docker limits this container to ${amount} (the container limit)${verdict}`;
  return `Docker shows this container ${amount} of RAM${verdict} Ollama may run elsewhere with more.`;
}
