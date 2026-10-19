import type { Item } from '../../../src/domain/schemas';
import { MODELS_AREA, PLATFORM_AREA } from './constants';
import { itemsIn } from './feedItems';

/** A valid digest over the items named in `prompt`, as the model's JSON reply. */
export function validDigest(items: readonly Item[], prompt: string): string {
  return JSON.stringify({
    headline: 'This week: tool calling and faster runners',
    intro: 'Three releases worth your time.',
    items: itemsIn(items, prompt).map((item) => ({
      itemId: item.id,
      title: item.title,
      url: item.url,
      area: item.kind === 'github' ? PLATFORM_AREA : MODELS_AREA,
      summary: `${item.title} is out.`,
      whyItMatters: 'Teams can drop a workaround they maintain today.',
      urgency: 'worth-a-look',
      action: 'Relevant if you run it.',
    })),
  });
}
