import { z } from 'zod';
import type { Validate } from '../types';

/** A prompt validator that accepts what `schema` accepts, judged on the trimmed value. */
export function validateWith(schema: z.ZodType, what: string): Validate {
  return (value) => schema.safeParse(value.trim()).success || `Enter a valid ${what}`;
}

export function isEmail(value: string): boolean {
  return z.email().safeParse(value.trim()).success;
}

/** Comma-separated text as a list: trimmed parts, none empty. */
export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}
