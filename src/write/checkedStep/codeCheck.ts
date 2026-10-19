import type { Draft, Item } from '../../domain/schemas';
import { formatCheck } from '../../checks/formatCheck';
import { linkCheck } from '../../checks/linkCheck';
import { renderDigest, type RenderOptions } from '../../render/markdown';
import type { CodeChecked } from './types';

/** Renders the draft as the digest will read, and runs the link and format checks on that text. */
export function codeCheck(
  draft: Draft,
  collected: readonly Item[],
  render: RenderOptions,
): CodeChecked {
  const markdown = renderDigest(draft.digest, render);
  const link = linkCheck(draft.digest, markdown, collected);
  const format = formatCheck(draft.digest, markdown);
  return {
    draft,
    markdown,
    rejectedBy: [...(link.ok ? [] : ['linkCheck']), ...(format.ok ? [] : ['formatCheck'])],
    problems: [...format.problems, ...link.problems],
  };
}
