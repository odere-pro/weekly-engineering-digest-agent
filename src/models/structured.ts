// Structured generation shared by every generative step: schema in, validated object out,
// with exactly one repair attempt on invalid output (spec: Reliability, model calls).
import { z } from 'zod';
import type { GenerateRequest, GenerateResult, ModelProvider } from './ModelProvider';
import { DigestError } from '../shared/errors';
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from '../shared/untrusted';
import type { StepName } from '../domain/schemas';

export interface StructuredResult<T> {
  value: T;
  /** One entry per model call (1, or 2 when repaired). */
  calls: GenerateResult[];
  repaired: boolean;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
}

function validate<T>(
  schema: z.ZodType<T>,
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = parseJson(text);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${(error as Error).message}` };
  }
  const result = schema.safeParse(raw);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}

/**
 * Calls `generate` with the JSON Schema of `schema`, validates the output and, if invalid,
 * asks the same model once to repair it. Throws DigestError for `step` when repair fails.
 */
export async function generateStructured<T>(
  model: ModelProvider,
  request: Omit<GenerateRequest, 'jsonSchema'>,
  schema: z.ZodType<T>,
  step: StepName,
): Promise<StructuredResult<T>> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  const first = await model.generate({ ...request, jsonSchema });
  const firstCheck = validate(schema, first.text);
  if (firstCheck.ok) return { value: firstCheck.value, calls: [first], repaired: false };

  const repair = await model.generate({
    ...request,
    model: first.model,
    jsonSchema,
    prompt: [
      'Your previous answer did not match the required JSON schema.',
      `Problems:\n${firstCheck.error}`,
      // The answer can carry collected text, so it is data like any item.
      UNTRUSTED_DATA_RULE,
      `Previous answer:\n${wrapUntrusted('previous-answer', first.text)}`,
      'Return only the corrected JSON object.',
    ].join('\n\n'),
  });
  const repairCheck = validate(schema, repair.text);
  if (repairCheck.ok) return { value: repairCheck.value, calls: [first, repair], repaired: true };

  throw new DigestError(`Model output for ${step} failed validation after one repair attempt`, {
    step,
    cause: new Error(repairCheck.error),
  });
}
