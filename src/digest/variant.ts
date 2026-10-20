import type { VariantKind } from '../store/runRecord';

/** What a second run of a week is for. `keepUrls` are the first digest's items; never recorded. */
export interface RunVariant {
  readonly kind: VariantKind;
  /** The perspective's topic (kind `perspective`). Operator text, not model text. */
  readonly topic?: string;
  /** Source ids added for this run (kind `add-sources`). */
  readonly addedSources?: readonly string[];
  /** URLs of the first digest's items: they win relevance ties in the ranking. */
  readonly keepUrls?: readonly string[];
}

const SLUG_MAX = 40;
const LABEL_TOPIC_MAX = 40;

/** The topic as `[a-z0-9-]`, at most 40 characters, `topic` when nothing is left. */
export function topicSlug(topic: string): string {
  const words = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
  const slug = words.join('-').slice(0, SLUG_MAX).replace(/-$/, '');
  return slug === '' ? 'topic' : slug;
}

/** File and message slug: `enriched`, `complete` or `perspective-<topic>` (matches the Markdown channel's rule). */
export function variantSlug(variant: RunVariant): string {
  if (variant.kind === 'perspective') return `perspective-${topicSlug(variant.topic ?? '')}`;
  return variant.kind === 'complete' ? 'complete' : 'enriched';
}

/** Short human label for the subject and the view: `enriched`, `complete`, `perspective: <topic>`. */
export function variantLabel(variant: RunVariant): string {
  if (variant.kind === 'perspective') {
    return `perspective: ${(variant.topic ?? '').trim().slice(0, LABEL_TOPIC_MAX)}`;
  }
  return variant.kind === 'complete' ? 'complete' : 'enriched';
}

/** The topic a perspective run asks the classifier and the writers to favour; none for any other run. */
export function perspectiveOf(ctx: { variant?: RunVariant }): { perspective?: string } {
  const { variant } = ctx;
  return variant?.kind === 'perspective' && variant.topic ? { perspective: variant.topic } : {};
}
