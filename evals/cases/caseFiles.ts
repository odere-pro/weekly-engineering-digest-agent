import { join } from 'node:path';
import type { z } from 'zod';
import { DigestError } from '../../src/shared/errors';
import { normalizeUrl } from '../../src/shared/url';
import type { AttackCase } from '../schema';
import type { EvalWeek } from './evalSet';
import { listNames, requireJson } from './jsonFiles';

/** One JSON file per case; ids must be unique. */
export async function loadCaseDir<T extends { id: string }>(
  dir: string,
  schema: z.ZodType<T>,
  kind: string,
): Promise<T[]> {
  const names = (await listNames(dir)).filter((name) => name.endsWith('.json'));
  const cases: T[] = [];
  for (const name of names) cases.push(await requireJson(join(dir, name), schema));
  const ids = cases.map((c) => c.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) throw new DigestError(`${dir}: duplicate ${kind} id "${duplicate}"`);
  return cases;
}

/** An attack item must be its own item: a shared id or URL would be deduped before the guards. */
export function assertAttacksAreDistinct(
  attacks: readonly AttackCase[],
  weeks: readonly EvalWeek[],
): void {
  const owners = new Map<string, string>();
  for (const week of weeks) {
    for (const item of week.items) {
      owners.set(`id ${item.id}`, week.weekId);
      owners.set(`URL ${normalizeUrl(item.url)}`, week.weekId);
    }
  }
  for (const attack of attacks) {
    for (const key of [`id ${attack.item.id}`, `URL ${normalizeUrl(attack.item.url)}`]) {
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new DigestError(`attack ${attack.id} shares its ${key.split(' ')[0]} with ${owner}`);
      }
      owners.set(key, `attack ${attack.id}`);
    }
  }
}
