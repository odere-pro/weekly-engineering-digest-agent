// Test kit for the classify folders: scripted decision answers, generated JSON replies and prompt
// readers shared by the entry test and the subfeature tests. Not product code; coverage skips
// `__fixtures__/`.
import type { ClassifyDeps } from '../classify';
import type { Item } from '../../domain/schemas';
import type {
  DecideRequest,
  DecisionAnswer,
  DecisionQuestion,
  GenerateRequest,
} from '../../models/ModelProvider';
import { DATA_CLOSE, DATA_OPEN } from '../../shared/untrusted';
import { makeItem } from '../../../test/builders';
import { noopLogger, type FakeModelProvider } from '../../../test/fakes';

export const FOCUS_AREAS = ['AI models and tooling', 'Platform engineering'] as const;

export type Answers = Record<string, DecisionAnswer>;

/** One entry of a generate-mode classify batch reply. */
export interface GeneratedAnswer {
  id: string;
  relevance: number;
  area: string;
  hype: boolean;
  minorRelease: boolean;
}

export function makeDeps(
  model: FakeModelProvider,
  overrides: Partial<ClassifyDeps> = {},
): ClassifyDeps {
  return { model, focusAreas: FOCUS_AREAS, logger: noopLogger, ...overrides };
}

export function makeItems(count: number): Item[] {
  return Array.from({ length: count }, () => makeItem());
}

/** The four decision answers for one item, with the values a test cares about overridden. */
export function answersFor(
  overrides: {
    level?: number;
    area?: string;
    areaConfidence?: number;
    hype?: number;
    minorRelease?: number;
  } = {},
): Answers {
  const level = overrides.level ?? 2;
  return {
    relevance: {
      type: 'score',
      level,
      score: level / 3,
      probabilities: {},
      confidence: 0.8,
    },
    area: {
      type: 'choice',
      choice: overrides.area ?? FOCUS_AREAS[0],
      probabilities: {},
      confidence: overrides.areaConfidence ?? 0.9,
    },
    hype: { type: 'yesno', probability: overrides.hype ?? 0.1 },
    minorRelease: { type: 'yesno', probability: overrides.minorRelease ?? 0.2 },
  };
}

/** Text inside the untrusted data block labeled `label`, or undefined when there is none. */
export function dataBlock(text: string, label: string): string | undefined {
  const open = `${DATA_OPEN} ${label}>>>\n`;
  const start = text.indexOf(open);
  if (start === -1) return undefined;
  const end = text.indexOf(`\n${DATA_CLOSE}`, start);
  return end === -1 ? undefined : text.slice(start + open.length, end);
}

/** Item ids of the data blocks in a batch prompt, in prompt order. */
export function idsInPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/<<<DATA ([\w.:-]+)>>>/g)].map((match) => match[1] ?? '');
}

export function generated(id: string, overrides: Partial<GeneratedAnswer> = {}): GeneratedAnswer {
  return {
    id,
    relevance: 2,
    area: FOCUS_AREAS[1],
    hype: false,
    minorRelease: false,
    ...overrides,
  };
}

export function batchReply(answers: readonly GeneratedAnswer[]): string {
  return JSON.stringify({ items: answers });
}

/** Answers every item in the batch prompt, except ids in `skip`. */
export function answerBatch(
  request: GenerateRequest,
  skip: ReadonlySet<string> = new Set(),
): string {
  return batchReply(
    idsInPrompt(request.prompt)
      .filter((id) => !skip.has(id))
      .map((id) => generated(id)),
  );
}

export function question(
  request: DecideRequest | undefined,
  id: string,
): DecisionQuestion | undefined {
  return request?.questions[id];
}

/** One entry of a writer rescore reply. */
export interface RescoredAnswer {
  itemId: string;
  relevance: number;
  area: string;
  confidence: 'low' | 'high';
}

export function rescoreReply(answers: readonly RescoredAnswer[]): string {
  return JSON.stringify({ items: answers });
}
