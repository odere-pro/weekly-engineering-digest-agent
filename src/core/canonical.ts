import type { Digest, DigestItem } from './schemas.js';

/**
 * The digest as the guards and the judge read it: plain text with fixed wording, never the
 * Markdown the reader gets. Scoring stays the same whatever the template looks like, so eval
 * baselines stay comparable. Nothing here takes options, on purpose.
 */

/** The claims an item makes: its summary and why it matters. Groundedness checks these (W5-11). */
export function canonicalClaimText(item: DigestItem): string {
  return `${item.summary}\n${item.whyItMatters}`;
}

/** The headline and the intro, as groundedness checks them against the cited sources (W5-11). */
export function canonicalHeadlineText(digest: Digest): string {
  return `${digest.headline}\n${digest.intro}`;
}

function itemBlock(item: DigestItem): string {
  return [
    `Title: ${item.title}`,
    `Area: ${item.area}`,
    `Summary: ${item.summary}`,
    `Why it matters: ${item.whyItMatters}`,
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
