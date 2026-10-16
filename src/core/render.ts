import type { Digest, DigestItem, GuardCheckId } from './schemas.js';

export interface RenderOptions {
  /** Guards that were off this week; named in the footer. */
  disabledGuards: readonly GuardCheckId[];
}

function renderItem(item: DigestItem, index: number): string {
  return [
    `## ${index + 1}. ${item.title}`,
    item.summary,
    `**Why it matters:** ${item.whyItMatters}`,
    `[Source](${item.url})`,
  ].join('\n\n');
}

/** Digest -> Markdown. */
export function renderDigest(digest: Digest, options: RenderOptions): string {
  const blocks = [
    `# ${digest.headline}`,
    `_Week ${digest.weekId}_`,
    digest.intro,
    ...digest.items.map(renderItem),
  ];
  if (options.disabledGuards.length > 0) {
    blocks.push('---', `Guards off this week: ${options.disabledGuards.join(', ')}.`);
  }
  return `${blocks.join('\n\n')}\n`;
}
