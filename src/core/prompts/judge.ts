import type { DecisionQuestion } from '../../ports/ModelProvider.js';
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from '../../shared/untrusted.js';
import { renderDigest } from '../render.js';
import type { Draft, Item } from '../schemas.js';

/** Rubric criteria, in the order they are asked. Keys of `JudgeScore.byCriterion`. */
export const JUDGE_CRITERIA = ['accuracy', 'clarity', 'whyItMatters', 'focusFit'] as const;
export type JudgeCriterion = (typeof JUDGE_CRITERIA)[number];

/** Rating levels, lowest first. A level's position + 1 is its 1-5 rating. */
export const JUDGE_LEVELS = [
  '1 - poor',
  '2 - weak',
  '3 - adequate',
  '4 - good',
  '5 - excellent',
] as const;

type ScoreQuestion = Extract<DecisionQuestion, { type: 'score' }>;

function scoreQuestion(instructions: string): ScoreQuestion {
  return { type: 'score', instructions, levels: JUDGE_LEVELS };
}

/** The four rubric questions, asked about every draft in the same words. */
export function buildJudgeQuestions(
  focusAreas: readonly string[],
): Record<JudgeCriterion, ScoreQuestion> {
  return {
    accuracy: scoreQuestion(
      'How accurate is the digest against its source items? Every claim, version number and ' +
        'name must be supported by a source. Rate 1 if it states things the sources do not say.',
    ),
    clarity: scoreQuestion(
      'How clear is the digest? It should be easy to read, specific, concise and free of ' +
        'filler and marketing language.',
    ),
    whyItMatters: scoreQuestion(
      'How well does each item explain why it matters to engineers? Rate high when the reason ' +
        'is concrete and specific to the item, low when it is generic or repeats the summary.',
    ),
    focusFit: scoreQuestion(
      `How well does the digest fit these focus areas: ${focusAreas.join('; ')}? ` +
        'Rate high when every item belongs to one of them.',
    ),
  };
}

function renderSource(item: Item): string {
  return [
    `Title: ${item.title}`,
    `URL: ${item.url}`,
    `Published: ${item.publishedAt}`,
    `Summary: ${item.summary}`,
  ].join('\n');
}

export interface DraftSources {
  /** The collected items the draft cites, in digest order, each once. */
  found: Item[];
  /** How many cited item ids matched no collected item. */
  missingCount: number;
}

/** Looks up the collected items a draft's digest items cite. */
export function resolveDraftSources(draft: Draft, sources: readonly Item[]): DraftSources {
  const byId = new Map(sources.map((item) => [item.id, item]));
  const ids = [...new Set(draft.digest.items.map((entry) => entry.itemId))];
  const found = ids.flatMap((id) => byId.get(id) ?? []);
  return { found, missingCount: ids.length - found.length };
}

/**
 * The text the judge sees for one draft: the draft and only its own source items, each in its
 * own untrusted data block. Never holds a second draft or the writer's name.
 */
export function buildJudgeState(draft: Draft, found: readonly Item[]): string {
  return [
    UNTRUSTED_DATA_RULE,
    'Rate the digest draft below against the source items it is based on.',
    wrapUntrusted('draft', renderDigest(draft.digest, { disabledGuards: [] })),
    ...found.map((item) => wrapUntrusted(`source:${item.id}`, renderSource(item))),
  ].join('\n\n');
}
