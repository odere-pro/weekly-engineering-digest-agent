// Pairwise ranking experiment (W11-07): a Swiss-style tournament over the best candidates.
// Every game asks one yes/no question in both orders and averages the two answers, which
// cancels the model's bias for the first item. Item text always goes in as untrusted data.
import type { ScoredItem } from './classification';
import type { DecisionAnswer, DecisionQuestion, ModelProvider } from '../models/ModelProvider';
import { DigestError } from '../shared/errors';
import type { Logger } from '../shared/telemetry';
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from '../shared/untrusted';

/** Only this many candidates enter the tournament. */
export const PAIRWISE_TOP = 20;
/** Hard cap on decide calls per week (two per game). */
export const PAIRWISE_MAX_CALLS = 40;
const CALLS_PER_GAME = 2;
const QUESTION_ID = 'prefer';

export interface PairwiseDeps {
  model: ModelProvider;
  focusAreas: readonly string[];
  logger: Logger;
}

function question(focusAreas: readonly string[]): DecisionQuestion {
  const areas = focusAreas.map((area) => `"${area}"`).join(', ');
  return {
    type: 'yesno',
    instructions: `An engineer follows these focus areas: ${areas}. Is the FIRST item more important for them to read this week than the SECOND item?`,
    criteria: { yes: 'the first item matters more', no: 'the second item matters more' },
  };
}

function itemText(item: ScoredItem): string {
  return [`Title: ${item.title}`, `Source: ${item.sourceId}`, `Summary: ${item.summary}`].join(
    '\n',
  );
}

/** The decide() state for one game: the data rule, then both items as untrusted blocks. */
export function pairwiseState(first: ScoredItem, second: ScoredItem): string {
  return [
    UNTRUSTED_DATA_RULE,
    '',
    wrapUntrusted(`first-${first.id}`, itemText(first)),
    '',
    wrapUntrusted(`second-${second.id}`, itemText(second)),
  ].join('\n');
}

/** Probability that `first` matters more than `second`. */
async function ask(
  first: ScoredItem,
  second: ScoredItem,
  deps: PairwiseDeps,
  signalQuestion: DecisionQuestion,
): Promise<number> {
  const { answers } = await deps.model.decide({
    role: 'classify',
    state: pairwiseState(first, second),
    questions: { [QUESTION_ID]: signalQuestion },
  });
  const answer: DecisionAnswer | undefined = answers[QUESTION_ID];
  if (answer?.type !== 'yesno')
    throw new DigestError(
      `classify: expected a yesno answer to "${QUESTION_ID}" for ${first.id} vs ${second.id}, got ${answer?.type ?? 'none'}`,
      { step: 'classify' },
    );
  return answer.probability;
}

/** Share of the game won by `a`, with both orders averaged. */
async function play(
  a: ScoredItem,
  b: ScoredItem,
  deps: PairwiseDeps,
  signalQuestion: DecisionQuestion,
): Promise<number> {
  const aFirst = await ask(a, b, deps, signalQuestion);
  const bFirst = await ask(b, a, deps, signalQuestion);
  return (aFirst + (1 - bFirst)) / 2;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** Pairs neighbours in the current standing, skipping pairs that already met. */
function pairUp(
  standing: readonly ScoredItem[],
  met: ReadonlySet<string>,
): [ScoredItem, ScoredItem][] {
  const free = [...standing];
  const pairs: [ScoredItem, ScoredItem][] = [];
  for (let a = free.shift(); a !== undefined && free.length > 0; a = free.shift()) {
    const index = free.findIndex((b) => !met.has(pairKey(a.id, b.id)));
    const [b] = index === -1 ? [] : free.splice(index, 1);
    if (b !== undefined) pairs.push([a, b]);
  }
  return pairs;
}

/**
 * Ranks the first `PAIRWISE_TOP` items (the input must already be in rank order) and returns
 * their ids, best first. Rounds pair items with similar points; the game count is capped so
 * that decide calls never pass `PAIRWISE_MAX_CALLS`. With 20 items that is only two rounds, so
 * this is a short Swiss-style tournament and the order is noisy. Games run one at a time on
 * purpose: the machine holds one model at once. Role `classify` picks the decider model.
 * Items are not mutated.
 */
export async function pairwiseRank(
  items: readonly ScoredItem[],
  deps: PairwiseDeps,
): Promise<string[]> {
  const candidates = items.slice(0, PAIRWISE_TOP);
  if (candidates.length < 2) return candidates.map((item) => item.id);
  const signalQuestion = question(deps.focusAreas);
  const points = new Map(candidates.map((item) => [item.id, 0]));
  const met = new Set<string>();
  const startOrder = new Map(candidates.map((item, index) => [item.id, index]));
  const pointsOf = (id: string): number => points.get(id) ?? 0;
  const startOf = (id: string): number => startOrder.get(id) ?? 0;
  /** Most points first; equal points keep the input order. */
  const byStanding = (a: ScoredItem, b: ScoredItem): number =>
    pointsOf(b.id) - pointsOf(a.id) || startOf(a.id) - startOf(b.id);
  let games = 0;
  const maxGames = Math.floor(PAIRWISE_MAX_CALLS / CALLS_PER_GAME);

  for (let round = 0; round < candidates.length - 1; round += 1) {
    const standing = candidates.toSorted(byStanding);
    const pairs = pairUp(standing, met).slice(0, maxGames - games);
    if (pairs.length === 0) break;
    for (const [a, b] of pairs) {
      const share = await play(a, b, deps, signalQuestion);
      met.add(pairKey(a.id, b.id));
      points.set(a.id, pointsOf(a.id) + share);
      points.set(b.id, pointsOf(b.id) + (1 - share));
      games += 1;
    }
    if (games >= maxGames) break;
  }
  deps.logger.info('Pairwise ranked items', {
    items: candidates.length,
    decideCalls: games * CALLS_PER_GAME,
  });
  return candidates.toSorted(byStanding).map((item) => item.id);
}
