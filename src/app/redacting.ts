// Defence in depth (F34): the adapters keep secrets out of their error messages, and the logger and
// tracer redact what they write. These decorators do the same for everything that reaches the
// run store or a delivery channel, so a leak in one adapter ends up in none of them.
import type { Delivery } from '../delivery/Delivery';
import type { Redactor } from '../observability/redact';
import { DigestError } from '../shared/errors';
import { RunRecordSchema, type RunRecord } from '../store/runRecord';
import type { RunStore } from '../store/RunStore';
import { decorate, type MemberRules } from './decorate';
import { redactMessage, redactNote } from './redaction/deliveryFields';

/**
 * Every member of the run store, and how it is wrapped: what is written goes through the redactor,
 * what is read or only asked about goes straight to the store.
 */
const STORE_RULES: MemberRules<RunStore, Redactor> = {
  acquireLock: (store) => (runId) => store.acquireLock(runId),
  hasSentDigest: (store) => (runId) => store.hasSentDigest(runId),
  saveArtifact: (store, redactor) => (runId, name, content) =>
    store.saveArtifact(runId, name, redactor.text(content)),
  readArtifact: (store) => (runId, name) => store.readArtifact(runId, name),
  removeArtifact: (store) => (runId, name) => store.removeArtifact(runId, name),
  // async, so a record that cannot be redacted rejects, as the port promises, instead of throwing.
  saveRunRecord: (store, redactor) => async (record) => {
    await store.saveRunRecord(redactedRecord(record, redactor));
  },
  getRunRecord: (store) => (runId) => store.getRunRecord(runId),
  sentUrls: (store) => (runId, weeks) => store.sentUrls(runId, weeks),
  listRuns: (store) => (limit) => store.listRuns(limit),
  prune: (store) => (runId, keepWeeks) => store.prune(runId, keepWeeks),
};

/**
 * A run store that redacts the run record and every artifact on the way in. Reads are untouched.
 * A record that cannot be redacted is not saved: that is the safe way for this check to fail.
 */
export function redactStore(store: RunStore, redactor: Redactor): RunStore {
  return decorate(store, redactor, STORE_RULES);
}

/**
 * A copy of the record with the secrets taken out of every string, checked against the record
 * schema: a secret that equals a value the record needs (a password of "sent") would rewrite it,
 * and a record that no longer fits is not saved, rather than saved wrong.
 */
function redactedRecord(record: RunRecord, redactor: Redactor): RunRecord {
  const copy = redactor.value(record);
  const checked = RunRecordSchema.safeParse(copy);
  if (!checked.success) {
    throw new DigestError(
      `Could not redact the run record for ${record.runId}; it was not saved, so no secret reaches the disk`,
    );
  }
  return checked.data;
}

/** Every member of a delivery channel, and how it is wrapped: the id as it is, the texts redacted. */
const DELIVERY_RULES: MemberRules<Delivery, Redactor> = {
  id: (delivery) => delivery.id,
  sendDigest: (delivery, redactor) => (message) =>
    delivery.sendDigest(redactMessage(message, redactor)),
  sendFailure: (delivery, redactor) => (note) => delivery.sendFailure(redactNote(note, redactor)),
  clearFailure: (delivery) => (weekId) => delivery.clearFailure(weekId),
};

/** A channel that gets the digest and the failure notes with the secrets taken out of the text. */
export function redactDelivery(delivery: Delivery, redactor: Redactor): Delivery {
  return decorate(delivery, redactor, DELIVERY_RULES);
}
