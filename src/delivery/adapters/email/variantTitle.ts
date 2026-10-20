import type { DigestView } from '../../../render/digestView';
import { oneLine } from './safeText';

/** The view's title, with its variant label in parentheses when it has one. */
export function withVariant(view: Pick<DigestView, 'title' | 'variant'>): string {
  const label = oneLine(view.variant ?? '');
  return label === '' ? view.title : `${view.title} (${label})`;
}
