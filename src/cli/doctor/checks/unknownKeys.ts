import { z } from 'zod';
import { ConfigSchema } from '../../../config/schema';
import { printableLine, truncate } from '../../../shared/text';
import { warn, type CheckResult } from '../report/checkResult';
import type { DoctorIo } from '../types';

/** A key of the config file that the schema does not know, and the one known key it may mean. */
export interface UnknownKey {
  /** Dotted, with `[i]` for list entries: `delivery.emial`, `sources[1].urll`. */
  path: string;
  suggestion?: string;
}

/** "Did you mean" reaches this far; a typo of three letters or more is a different word. */
const MAX_TYPO_DISTANCE = 2;
/** A key is cut to this many characters in a label, so a long or hostile key cannot flood the screen. */
const MAX_KEY_CHARS = 80;
const CONFIG_KEYS_DOC = 'docs/reference/config-keys.md';

/**
 * One warning per key of `digest.config.json` that the schema would drop. `ConfigSchema` strips
 * unknown keys, so a run ignores a typo (`topn`) and uses the default; this is where the user
 * hears about it. Reads the file the loader read. If it cannot be read again or parsed, it says
 * nothing: the loader has just reported any real problem with the file.
 */
export async function checkUnknownKeys(
  configPath: string,
  io: Pick<DoctorIo, 'readFile'>,
): Promise<CheckResult[]> {
  const json = await readJson(configPath, io);
  return findUnknownKeys(json).map(({ path, suggestion }) =>
    warn(
      `config key ${JSON.stringify(truncate(printableLine(path), MAX_KEY_CHARS))}`,
      `not a setting, so a run ignores it and the default applies${
        suggestion === undefined
          ? ''
          : `; did you mean ${JSON.stringify(truncate(printableLine(suggestion), MAX_KEY_CHARS))}?`
      }`,
      `rename or remove it in digest.config.json; every key is listed in ${CONFIG_KEYS_DOC}`,
    ),
  );
}

async function readJson(configPath: string, io: Pick<DoctorIo, 'readFile'>): Promise<unknown> {
  try {
    return JSON.parse(await io.readFile(configPath));
  } catch {
    return undefined;
  }
}

/**
 * The keys in `value` (parsed JSON) that `schema` does not know, in file order. Walks objects and
 * lists, looks through optional, nullable, default, prefault, readonly, catch and pipe wrappers,
 * and leaves alone whatever has no fixed key list: a record, a union, and an object that keeps
 * other keys (`looseObject`) or refuses them itself (`strictObject`).
 */
export function findUnknownKeys(
  value: unknown,
  schema: z.ZodType = ConfigSchema,
  prefix = '',
): UnknownKey[] {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodArray) return unknownInList(value, inner.element as z.ZodType, prefix);
  if (inner instanceof z.ZodObject && inner.def.catchall === undefined) {
    return unknownInObject(value, inner.shape, prefix);
  }
  return [];
}

function unknownInList(value: unknown, element: z.ZodType, prefix: string): UnknownKey[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown, index) =>
    findUnknownKeys(entry, element, `${prefix}[${index}]`),
  );
}

function unknownInObject(
  value: unknown,
  shape: Readonly<Record<string, z.ZodType>>,
  prefix: string,
): UnknownKey[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const known = Object.keys(shape);
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const child = Object.hasOwn(shape, key) ? shape[key] : undefined;
    if (child !== undefined) return findUnknownKeys(entry, child, path);
    const suggestion = closestKey(key, known);
    return [suggestion === undefined ? { path } : { path, suggestion: join(prefix, suggestion) }];
  });
}

const join = (prefix: string, key: string): string => (prefix === '' ? key : `${prefix}.${key}`);

/** The schema under optional, nullable, default, prefault, readonly, catch and pipe wrappers. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  for (;;) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodPrefault ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodCatch ||
      current instanceof z.ZodNonOptional
    ) {
      current = current.def.innerType as z.ZodType;
    } else if (current instanceof z.ZodPipe) {
      current = current.def.in as z.ZodType;
    } else {
      return current;
    }
  }
}

/**
 * The one known key within `MAX_TYPO_DISTANCE` edits of `key`, ignoring case; undefined when none
 * is, or when two are equally plausible. An edit count as large as the key would suggest anything.
 */
function closestKey(key: string, known: readonly string[]): string | undefined {
  const typed = key.toLowerCase();
  const near = known.filter((candidate) => {
    const distance = editDistance(typed, candidate.toLowerCase());
    return distance <= MAX_TYPO_DISTANCE && distance < typed.length;
  });
  return near.length === 1 ? near[0] : undefined;
}

/** Optimal string alignment: insert, delete, replace or swap two neighbouring letters, one edit each. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        cell(rows, i - 1, j) + 1,
        cell(rows, i, j - 1) + 1,
        cell(rows, i - 1, j - 1) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, cell(rows, i - 2, j - 2) + 1);
      }
      (rows[i] as number[])[j] = best;
    }
  }
  return cell(rows, a.length, b.length);
}

const cell = (rows: readonly (readonly number[])[], i: number, j: number): number =>
  rows[i]?.[j] ?? Number.POSITIVE_INFINITY;
