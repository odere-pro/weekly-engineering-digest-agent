import { cell, table } from './table';
import type { Item } from '../../../domain/schemas';

const DATE_CHARS = 'YYYY-MM-DD'.length;

/** The collected items: source, title, publish date, URL. */
export function itemsTable(items: readonly Item[]): string {
  if (items.length === 0) return 'No items were collected.\n';
  const header = ['Source', 'Title', 'Published', 'URL'];
  return table([
    header,
    ...items.map((item) => [
      cell(item.sourceId),
      cell(item.title),
      item.publishedAt.slice(0, DATE_CHARS),
      item.url,
    ]),
  ]);
}
