// Writer prompt (W1-09). Every writer in the panel gets the same system and user prompt.
import { DIGEST_MAX_ITEMS, DIGEST_MIN_ITEMS, DIGEST_WORD_LIMIT } from '../checks/formatCheck.js';
import type { ScoredItem } from '../schemas.js';
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from '../../shared/untrusted.js';

/** The format rules come from the format check, so the prompt and the check cannot drift apart. */
export { DIGEST_MAX_ITEMS, DIGEST_MIN_ITEMS, DIGEST_WORD_LIMIT };
/** What the writer aims for, leaving room for the words the renderer adds around each item. */
export const DIGEST_WORD_TARGET = 400;

export interface WritePrompt {
  system: string;
  prompt: string;
}

const ROLE = [
  'You write a weekly digest for senior engineers who build with AI models and run platforms.',
  'You pick the releases that matter most this week and explain each one plainly.',
].join(' ');

const OUTPUT_RULES = [
  'Output rules:',
  `- Pick ${DIGEST_MIN_ITEMS} to ${DIGEST_MAX_ITEMS} items from the data, the ones that matter most for the focus areas. Use no other items.`,
  '- For each item, copy itemId and url exactly as they appear in the data. Never invent or change them.',
  `- One entry per release. If two items describe the same release or product (for example a project's release notes and a cloud vendor's availability post), write one entry for it, using the itemId of the better source, and fold the other item's facts into its summary. If that would leave fewer than ${DIGEST_MIN_ITEMS} entries, keep them as separate entries.`,
  '- title: the item title, shortened if it is long. Replace any em dash in it with a colon. Name a version or release tag once: "tool v1.2.0", not "tool v1.2.0: Release v1.2.0".',
  "- area: the item's area as given in the data.",
  '- summary: one or two plain sentences on what shipped or changed. Facts from the data only.',
  '- whyItMatters: why it matters, in one concrete sentence: what a team can now do, stop doing or must change.',
  '  Avoid generic praise such as "a game changer" or "an exciting step forward".',
  '- headline: one short factual line. intro: one or two sentences tying the items together.',
  '- Do not use em dashes (U+2014). Use commas, colons or periods instead.',
  `- Keep the whole digest under ${DIGEST_WORD_LIMIT} words in total; aim for about ${DIGEST_WORD_TARGET}.`,
  '- Return only the JSON object that matches the schema, with no text around it.',
].join('\n');

const WORKED_EXAMPLE = [
  `Example. It shows one item for brevity; your digest has ${DIGEST_MIN_ITEMS} to ${DIGEST_MAX_ITEMS}. Never copy the example item.`,
  'Input item:',
  'id: ex-7f3a',
  'title: Runner 2.4 adds ephemeral GPU runners',
  'url: https://example.com/runner/releases/2.4.0',
  'area: Platform engineering',
  'summary: Runner 2.4 can start a fresh GPU runner per job and remove it when the job ends.',
  'Output item:',
  JSON.stringify({
    itemId: 'ex-7f3a',
    title: 'Runner 2.4 adds ephemeral GPU runners',
    url: 'https://example.com/runner/releases/2.4.0',
    area: 'Platform engineering',
    summary: 'Runner 2.4 starts a fresh GPU runner for each job and removes it afterwards.',
    whyItMatters: 'Teams can run model evals in CI without keeping GPU machines idle between jobs.',
  }),
].join('\n');

const SYSTEM = [ROLE, UNTRUSTED_DATA_RULE, OUTPUT_RULES, WORKED_EXAMPLE].join('\n\n');

function describeItem(item: ScoredItem): string {
  return [
    `id: ${item.id}`,
    `title: ${item.title}`,
    `url: ${item.url}`,
    `area: ${item.classification.area}`,
    `summary: ${item.summary}`,
  ].join('\n');
}

/** System and user prompt for one writer; every writer gets the same one. */
export function buildWritePrompt(
  items: readonly ScoredItem[],
  focusAreas: readonly string[],
): WritePrompt {
  const prompt = [
    `Focus areas:\n${focusAreas.map((area) => `- ${area}`).join('\n')}`,
    `This week's top items (${items.length}):`,
    ...items.map((item) => wrapUntrusted(item.id, describeItem(item))),
    'Write the digest as JSON now.',
  ].join('\n\n');
  return { system: SYSTEM, prompt };
}
