import type { z } from 'zod';
import { ShowError } from './showError';
import { errorMessage } from '../../shared/errors';

/**
 * A saved JSON file as a typed value. A shape error names only the file; a JSON error adds
 * `JSON.parse`'s own message, which can echo a few characters of the text.
 */
export function parseFile<T>(name: string, raw: string, schema: z.ZodType<T>): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ShowError(`${name} is not valid JSON: ${errorMessage(error)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ShowError(`${name} does not have the expected shape`);
  return parsed.data;
}
