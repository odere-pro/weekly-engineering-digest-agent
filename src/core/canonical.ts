import type { Digest, DigestItem } from './schemas.js';

/**
 * The digest as the guards and the judge read it: plain text with fixed wording, never the
 * Markdown the reader gets. Scoring stays the same whatever the template looks like, so eval
 * baselines stay comparable. Nothing here takes options, on purpose.
 */

/** The action line, or undefined when the item has none (good-to-know items, and old drafts). */
function actionOf(item: DigestItem): string | undefined {
  const action = item.action?.trim();
  return action === '' ? undefined : action;
}

/**
 * The claims an item makes: its summary, why it matters and, since W8-01, its action line.
 * Groundedness checks these (W5-11). An item with no action reads exactly as it did in W5-11.
 */
export function canonicalClaimText(item: DigestItem): string {
  const action = actionOf(item);
  return [item.summary, item.whyItMatters, ...(action === undefined ? [] : [action])].join('\n');
}

/** The headline and the intro, as groundedness checks them against the cited sources (W5-11). */
export function canonicalHeadlineText(digest: Digest): string {
  return `${digest.headline}\n${digest.intro}`;
}

/**
 * Urgency and action are lines of their own, and only when the item has them: a draft written
 * before W8 reads byte for byte as it did in W7-04, so recorded baselines stay comparable.
 */
function itemBlock(item: DigestItem): string {
  const action = actionOf(item);
  return [
    `Title: ${item.title}`,
    `Area: ${item.area}`,
    ...(item.urgency === undefined ? [] : [`Urgency: ${item.urgency}`]),
    `Summary: ${item.summary}`,
    `Why it matters: ${item.whyItMatters}`,
    ...(action === undefined ? [] : [`Action: ${action}`]),
    `URL: ${item.url}`,
  ].join('\n');
}

/** Headline, intro, then one block per item in order, a blank line between blocks. */
export function canonicalDigestText(digest: Digest): string {
  return [
    `Headline: ${digest.headline}`,
    `Intro: ${digest.intro}`,
    ...digest.items.map(itemBlock),
  ].join('\n\n');
}
