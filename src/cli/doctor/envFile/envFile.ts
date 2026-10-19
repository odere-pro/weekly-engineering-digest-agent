import { errorMessage } from '../../../shared/errors';
import { isNotFound } from '../errorCode';
import { ok, warn, type CheckResult } from '../report/checkResult';
import type { DoctorIo } from '../types';
import { keysCutAtHash } from './keysCutAtHash';

const OTHERS_PERMISSION_MASK = 0o077;
const PERMISSION_MASK = 0o777;
const OCTAL = 8;

/** Whether other users can read the `.env` file. A missing file is fine: secrets can come from the environment. */
export async function checkEnvFile(io: Pick<DoctorIo, 'stat' | 'envPath'>): Promise<CheckResult> {
  const label = '.env';
  try {
    const { mode } = await io.stat(io.envPath);
    if ((mode & OTHERS_PERMISSION_MASK) === 0) return ok(label, 'readable only by you');
    const shown = (mode & PERMISSION_MASK).toString(OCTAL);
    return warn(label, `readable by other users (mode ${shown})`, 'chmod 600 .env');
  } catch (error) {
    if (isNotFound(error)) {
      return ok(label, 'no .env file (secrets come from the process environment)');
    }
    return warn(
      label,
      `cannot inspect ${io.envPath}: ${errorMessage(error)}`,
      'check that .env exists and that you can read it',
    );
  }
}

/**
 * `.env` values that node's parser cut at a "#": it reads an unquoted value only up to its first
 * "#" (a password `pa#ss` becomes `pa`) and never says so. A warning names the keys and the lines,
 * never a value.
 */
export async function checkEnvValues(
  io: Pick<DoctorIo, 'readFile' | 'envPath'>,
): Promise<CheckResult[]> {
  const label = '.env values';
  let text: string;
  try {
    text = await io.readFile(io.envPath);
  } catch (error) {
    if (isNotFound(error)) return []; // the .env check already says there is none
    return [
      warn(
        label,
        `cannot read ${io.envPath}: ${errorMessage(error)}`,
        'check that you can read .env',
      ),
    ];
  }
  const cut = keysCutAtHash(text);
  if (cut.length === 0) return [ok(label, 'no unquoted value contains a "#"')];
  const where = cut.map(({ key, line }) => `${key} (line ${line})`).join(', ');
  return [
    warn(
      label,
      `${where}: the unquoted value has a "#", and everything from it on is read as a comment; if the "#" belongs to the value, it is cut short`,
      'put the value in quotes if the "#" is part of it, for example KEY="pass#word"',
    ),
  ];
}
