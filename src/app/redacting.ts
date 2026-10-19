// Defence in depth (F34): the adapters keep secrets out of their error messages, and the logger and
// tracer redact what they write. These decorators do the same for everything that reaches the
// run store or a delivery channel, so a leak in one adapter ends up in none of them.
import type { Secrets } from '../config/schema';
import type { Redactor } from '../observability/redact';
import type {
  Delivery,
  DigestMessage,
  DigestView,
  DigestViewGroup,
  DigestViewItem,
  FailureNote,
} from '../delivery/Delivery';
import { RunRecordSchema, type RunRecord } from '../store/runRecord';
import type { RunStore } from '../store/RunStore';
import { DigestError } from '../shared/errors';

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

/**
 * How each field of a delivery type is redacted. Every field needs a rule, optional ones too, so a
 * field added to `DigestMessage`, `FailureNote` or the view later is a type error until it has one.
 */
export type FieldRules<T> = {
  readonly [K in keyof T]-?: (value: NonNullable<T[K]>, redactor: Redactor) => NonNullable<T[K]>;
};

/** For ids set in code (week, step, urgency), never text from a feed, a model or an error. */
const unchanged = <V>(value: V): V => value;
const text = (value: string, redactor: Redactor): string => redactor.text(value);

const ITEM_RULES: FieldRules<DigestViewItem> = {
  title: text,
  url: text,
  whatChanged: text,
  action: text,
};

const GROUP_RULES: FieldRules<DigestViewGroup> = {
  urgency: unchanged,
  label: text,
  items: (items, redactor) => items.map((item) => redactFields(item, ITEM_RULES, redactor)),
};

const VIEW_RULES: FieldRules<DigestView> = {
  weekId: unchanged,
  title: text,
  headline: text,
  groups: (groups, redactor) => groups.map((group) => redactFields(group, GROUP_RULES, redactor)),
  footer: text,
};

const MESSAGE_RULES: FieldRules<DigestMessage> = {
  weekId: unchanged,
  subject: text,
  markdown: text,
  view: (view, redactor) => redactFields(view, VIEW_RULES, redactor),
};

const NOTE_RULES: FieldRules<FailureNote> = {
  weekId: unchanged,
  step: unchanged,
  message: text,
};

/**
 * A copy that has only the fields with a rule, each passed through it. A field the type does not
 * know (an object built with a cast) is dropped, never sent as it is. An absent field stays absent.
 */
function redactFields<T extends object>(value: T, rules: FieldRules<T>, redactor: Redactor): T {
  const fields = (Object.keys(rules) as (keyof T)[]).flatMap((key): [keyof T, unknown][] => {
    const field = value[key];
    return field === undefined || field === null ? [] : [[key, rules[key](field, redactor)]];
  });
  return Object.fromEntries(fields) as T;
}

/** A channel that gets the digest and the failure notes with the secrets taken out of the text. */
export function redactDelivery(delivery: Delivery, redactor: Redactor): Delivery {
  return {
    id: delivery.id,
    sendDigest: (message) => delivery.sendDigest(redactFields(message, MESSAGE_RULES, redactor)),
    sendFailure: (note) => delivery.sendFailure(redactFields(note, NOTE_RULES, redactor)),
  };
}
