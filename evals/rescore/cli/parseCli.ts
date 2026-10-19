import { parseArgs } from 'node:util';
import { ProfileNameSchema, type ProfileName } from '../../../src/config/schema';
import { errorMessage } from '../../../src/shared/errors';
import { parseHoldoutWeeks } from '../../thresholds/split';

export const USAGE =
  'Usage: tsx evals/rescoreReplay.ts --profile light|fast|... --flag on|off [--config <digest.config.json>] [--calibration <file>] [--holdout <weeks>] [--pairwise on|off]\n';

export type ParsedCli =
  | {
      ok: true;
      profile: ProfileName;
      flag: boolean;
      config: string | undefined;
      calibration: string | undefined;
      holdout: string[] | undefined;
      pairwise: boolean;
    }
  | { ok: false; reason: string };

/** The command line as values; a bad one comes back as `{ ok: false, reason }`, never thrown. */
export function parseCli(args: readonly string[]): ParsedCli {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        profile: { type: 'string' },
        flag: { type: 'string' },
        config: { type: 'string' },
        calibration: { type: 'string' },
        holdout: { type: 'string' },
        pairwise: { type: 'string' },
      },
    });
    const profile = ProfileNameSchema.safeParse(values.profile);
    if (!profile.success) return { ok: false, reason: 'unknown or missing --profile' };
    if (values.flag !== 'on' && values.flag !== 'off')
      return { ok: false, reason: '--flag must be on or off' };
    if (values.pairwise !== undefined && values.pairwise !== 'on' && values.pairwise !== 'off')
      return { ok: false, reason: '--pairwise must be on or off' };
    return {
      ok: true,
      profile: profile.data,
      flag: values.flag === 'on',
      config: values.config,
      calibration: values.calibration,
      holdout: values.holdout === undefined ? undefined : parseHoldoutWeeks(values.holdout),
      pairwise: values.pairwise === 'on',
    };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}
