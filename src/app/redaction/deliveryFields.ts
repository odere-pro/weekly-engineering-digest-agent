import type { DigestMessage, FailureNote } from '../../delivery/Delivery';
import type {
  DigestAppendix,
  DigestAppendixGroup,
  DigestAppendixItem,
  DigestView,
  DigestViewGroup,
  DigestViewItem,
} from '../../render/digestView';
import type { Redactor } from '../../observability/redact';

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

const APPENDIX_ITEM_RULES: FieldRules<DigestAppendixItem> = {
  title: text,
  url: text,
  line: text,
};

const APPENDIX_GROUP_RULES: FieldRules<DigestAppendixGroup> = {
  area: text,
  items: (items, redactor) =>
    items.map((item) => redactFields(item, APPENDIX_ITEM_RULES, redactor)),
};

const APPENDIX_RULES: FieldRules<DigestAppendix> = {
  title: text,
  groups: (groups, redactor) =>
    groups.map((group) => redactFields(group, APPENDIX_GROUP_RULES, redactor)),
};

const VIEW_RULES: FieldRules<DigestView> = {
  weekId: unchanged,
  title: text,
  headline: text,
  groups: (groups, redactor) => groups.map((group) => redactFields(group, GROUP_RULES, redactor)),
  footer: text,
  variant: text,
  appendix: (appendix, redactor) => redactFields(appendix, APPENDIX_RULES, redactor),
};

const MESSAGE_RULES: FieldRules<DigestMessage> = {
  weekId: unchanged,
  subject: text,
  markdown: text,
  view: (view, redactor) => redactFields(view, VIEW_RULES, redactor),
  // A slug built in code from `[a-z0-9-]`; it becomes a file name, so it must stay as it is.
  variant: unchanged,
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

/** The digest message with the secrets taken out of every text of it and of its view. */
export function redactMessage(message: DigestMessage, redactor: Redactor): DigestMessage {
  return redactFields(message, MESSAGE_RULES, redactor);
}

/** The failure note with the secrets taken out of its message. */
export function redactNote(note: FailureNote, redactor: Redactor): FailureNote {
  return redactFields(note, NOTE_RULES, redactor);
}
