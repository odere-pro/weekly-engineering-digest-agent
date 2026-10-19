import { z } from 'zod';
import { cell, formatScore, table } from './table';
import { parseFile } from '../parseFile';
import { ClassificationSchema } from '../../../classify/classification';
import { DraftsFileSchema } from '../../../digest/runEnding';
import { ItemSchema } from '../../../domain/schemas';
import type { RunStore } from '../../../store/RunStore';

const PERCENT = 100;

const percent = (probability: number): string => `${Math.round(probability * PERCENT)}%`;

/** The item ids of the winning draft; empty when the week has no readable drafts. */
export async function digestItemIds(week: string, store: RunStore): Promise<Set<string>> {
  const [record, raw] = await Promise.all([
    store.getRunRecord(week),
    store.readArtifact(week, 'drafts.json'),
  ]);
  if (raw === undefined || record?.winner == null) return new Set();
  const drafts = parseFile('drafts.json', raw, DraftsFileSchema).drafts;
  const winner = drafts.find((draft) => draft.writer === record.winner);
  return new Set(winner?.digest.items.map((item) => item.itemId));
}

/** One row per score with what happened to the item, then the items the input guard dropped. */
export async function scoresTable(week: string, raw: string, store: RunStore): Promise<string> {
  const scores = parseFile('scores.json', raw, z.array(ClassificationSchema));
  const itemsRaw = await store.readArtifact(week, 'items.json');
  const items =
    itemsRaw === undefined ? [] : parseFile('items.json', itemsRaw, z.array(ItemSchema));
  const inDigest = await digestItemIds(week, store);
  const titles = new Map(items.map((item) => [item.id, item.title]));
  const scored = new Set(scores.map((score) => score.itemId));
  const header = ['Item', 'Relevance', 'Area', 'Hype', 'Minor', 'Status'];
  const rows = scores.map((score) => [
    cell(titles.get(score.itemId) ?? score.itemId),
    formatScore(score.relevance),
    cell(`${score.area} (${percent(score.areaConfidence)})`),
    percent(score.hype),
    percent(score.minorRelease),
    inDigest.has(score.itemId) ? 'in digest' : 'scored, not picked',
  ]);
  const dropped = items
    .filter((item) => !scored.has(item.id))
    .map((item) => [cell(item.title), '-', '-', '-', '-', 'dropped before scoring (input guard)']);
  return table([header, ...rows, ...dropped]);
}
