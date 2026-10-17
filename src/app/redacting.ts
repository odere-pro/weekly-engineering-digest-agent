// Defence in depth (F34): the adapters keep secrets out of their error messages, and the logger and
// tracer redact what they write. These decorators do the same for everything that reaches the
// run store or a delivery channel, so a leak in one adapter ends up in none of them.
import type { Secrets } from '../config/schema.js';
import type { Redactor } from '../observability/redact.js';
import type { Delivery, DigestView } from '../ports/Delivery.js';
import { RunRecordSchema, type RunRecord } from '../core/schemas.js';
import type { RunStore } from '../ports/RunStore.js';
import { DigestError } from '../shared/errors.js';

/**
 * Every secret value that is set, plus the path of the Slack webhook: the path is the secret part
 * of that URL, and a message can carry it without the host. Comes from the loaded secrets only.
 */
export function knownSecrets(secrets: Secrets): string[] {
  const values = Object.values(secrets).filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  const path = webhookPath(secrets.SLACK_WEBHOOK_URL);
  return path === undefined ? values : [...values, path];
}

function webhookPath(webhookUrl: string | undefined): string | undefined {
  if (webhookUrl === undefined || webhookUrl === '') return undefined;
  try {
    const { pathname } = new URL(webhookUrl);
    return pathname.length > 1 ? pathname : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A run store that redacts the run record and every artifact on the way in. Reads are untouched.
 * A record that cannot be redacted is not saved: that is the safe way for this check to fail.
 */
export function redactStore(store: RunStore, redactor: Redactor): RunStore {
  return {
    acquireLock: (runId) => store.acquireLock(runId),
    hasSentDigest: (runId) => store.hasSentDigest(runId),
    saveArtifact: (runId, name, content) => store.saveArtifact(runId, name, redactor.text(content)),
    readArtifact: (runId, name) => store.readArtifact(runId, name),
    // async, so a record that cannot be redacted rejects, as the port promises, instead of throwing.
    saveRunRecord: async (record) => {
      await store.saveRunRecord(redactedRecord(record, redactor));
    },
    getRunRecord: (runId) => store.getRunRecord(runId),
    sentUrls: (runId, weeks) => store.sentUrls(runId, weeks),
    listRuns: (limit) => store.listRuns(limit),
    prune: (runId, keepWeeks) => store.prune(runId, keepWeeks),
  };
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

/** The laid-out digest with the secrets taken out of every text, the URLs included. */
function redactedView(view: DigestView, redactor: Redactor): DigestView {
  const text = (value: string): string => redactor.text(value);
  return {
    weekId: view.weekId,
    title: text(view.title),
    headline: text(view.headline),
    groups: view.groups.map((group) => ({
      urgency: group.urgency,
      label: text(group.label),
      items: group.items.map((item) => ({
        title: text(item.title),
        url: text(item.url),
        whatChanged: text(item.whatChanged),
        ...(item.action === undefined ? {} : { action: text(item.action) }),
      })),
    })),
    ...(view.footer === undefined ? {} : { footer: text(view.footer) }),
  };
}

/** A channel that gets the digest and the failure notes with the secrets taken out of the text. */
export function redactDelivery(delivery: Delivery, redactor: Redactor): Delivery {
  return {
    id: delivery.id,
    sendDigest: (message) =>
      delivery.sendDigest({
        ...message,
        subject: redactor.text(message.subject),
        markdown: redactor.text(message.markdown),
        ...(message.view === undefined ? {} : { view: redactedView(message.view, redactor) }),
      }),
    sendFailure: (note) => delivery.sendFailure({ ...note, message: redactor.text(note.message) }),
  };
}
