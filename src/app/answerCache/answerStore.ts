import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { DecisionAnswer } from '../../models/ModelProvider';
import { readTextIfExists } from '../../shared/atomicFile';
import { weekAnswersFile } from '../../store/layout';

/** One saved answer: the key of the call, the model that gave it, and what it said. */
export type StoredAnswer =
  | {
      key: string;
      op: 'decide';
      model: string;
      answers: Readonly<Record<string, DecisionAnswer>>;
    }
  | { key: string; op: 'generate'; model: string; text: string };

interface LoadedAnswers {
  entries: Map<string, StoredAnswer>;
  /** Lines that could not be read (a crash mid-write, a hand edit); each is a miss. */
  skipped: number;
}

/** The week's saved answers on disk: one JSON line each, never a prompt. */
export interface AnswerStore {
  load(weekId: string): Promise<LoadedAnswers>;
  /** Adds one answer at the end of the week's file, creating the folder when needed. */
  append(weekId: string, answer: StoredAnswer): Promise<void>;
}

export interface AnswerStoreOptions {
  dataDir: string;
  /** Takes known secrets out of a generated text before it is written. */
  redact: (text: string) => string;
}

const ProbabilitiesSchema = z.record(z.string(), z.number());

const DecisionAnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('yesno'), probability: z.number() }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: ProbabilitiesSchema,
    confidence: z.number(),
  }),
  z.object({
    type: z.literal('score'),
    level: z.number(),
    score: z.number(),
    probabilities: ProbabilitiesSchema,
    confidence: z.number(),
  }),
]);

const KeySchema = z.string().regex(/^[0-9a-f]{64}$/);

/** A line of the file. `k` and the short field names keep a week's file small. */
const LineSchema = z.discriminatedUnion('op', [
  z.object({
    k: KeySchema,
    op: z.literal('decide'),
    model: z.string(),
    answers: z.record(z.string(), DecisionAnswerSchema),
  }),
  z.object({ k: KeySchema, op: z.literal('generate'), model: z.string(), text: z.string() }),
]);
type Line = z.infer<typeof LineSchema>;

function toLine(answer: StoredAnswer, redact: (text: string) => string): Line {
  const { key, ...rest } = answer;
  return rest.op === 'generate'
    ? { k: key, op: 'generate', model: rest.model, text: redact(rest.text) }
    : { k: key, ...rest };
}

function fromLine(line: Line): StoredAnswer {
  const { k, ...rest } = line;
  return { key: k, ...rest };
}

function parseLine(text: string): StoredAnswer | undefined {
  try {
    const parsed = LineSchema.safeParse(JSON.parse(text));
    return parsed.success ? fromLine(parsed.data) : undefined;
  } catch {
    // Not JSON: a line a crash cut short. Counted as skipped by the caller.
    return undefined;
  }
}

function readLines(text: string): LoadedAnswers {
  const entries = new Map<string, StoredAnswer>();
  let skipped = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const answer = parseLine(raw);
    if (answer === undefined) skipped += 1;
    else entries.set(answer.key, answer);
  }
  return { entries, skipped };
}

/**
 * Saved answers in `<dataDir>/<monday>/digest/answers.jsonl` (`store/layout`), appended as they
 * come. A file that ends without a newline (a crash mid-line) gets one before the next answer, so a
 * torn line costs only itself.
 */
export function createAnswerStore(options: AnswerStoreOptions): AnswerStore {
  const torn = new Set<string>();
  return {
    async load(weekId) {
      const text = await readTextIfExists(weekAnswersFile(options.dataDir, weekId));
      if (text === undefined) return { entries: new Map(), skipped: 0 };
      if (text !== '' && !text.endsWith('\n')) torn.add(weekId);
      return readLines(text);
    },
    async append(weekId, answer) {
      const path = weekAnswersFile(options.dataDir, weekId);
      const lead = torn.has(weekId) ? '\n' : '';
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${lead}${JSON.stringify(toLine(answer, options.redact))}\n`);
      torn.delete(weekId);
    },
  };
}
