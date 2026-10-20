import type { DeliveryId } from '../../delivery/deliveryId';
import { DigestError } from '../../shared/errors';
import type { Clock } from '../../shared/clock';
import type { RunStore } from '../../store/RunStore';
import type { RunRecord } from '../../store/runRecord';
import type { RunVariant } from '../variant';

const union = <T>(a: readonly T[] = [], b: readonly T[]): T[] => [...new Set([...a, ...b])];

/**
 * Marks the week's record after a variant digest went out. A dry-run week becomes `sent` (the
 * variant is what was delivered); a sent week keeps its status and gains the channels and URLs. Any
 * other week, or none, throws: a variant is made from a finished week. Saves and returns the record.
 */
export async function markVariantSent(
  deps: { store: RunStore; clock: Clock },
  weekId: string,
  deliveredTo: readonly DeliveryId[],
  urls: readonly string[],
  variant: RunVariant,
): Promise<RunRecord> {
  const record = await deps.store.getRunRecord(weekId);
  const finishedAt = deps.clock.now().toISOString();
  const stored = {
    kind: variant.kind,
    ...(variant.topic !== undefined && { topic: variant.topic }),
    ...(variant.addedSources && { addedSources: [...variant.addedSources] }),
  };
  let next: RunRecord;
  if (record?.status === 'dry-run') {
    next = {
      ...record,
      status: 'sent',
      dryRun: false,
      deliveredTo: [...deliveredTo],
      sentUrls: [...urls],
      finishedAt,
      variant: stored,
    };
  } else if (record?.status === 'sent') {
    next = {
      ...record,
      finishedAt,
      deliveredTo: union(record.deliveredTo, deliveredTo),
      sentUrls: union(record.sentUrls, urls),
      variant: stored,
    };
  } else {
    throw new DigestError(
      `Week ${weekId} has no sent or dry-run digest to attach a ${variant.kind} digest to`,
    );
  }
  await deps.store.saveRunRecord(next);
  return next;
}
