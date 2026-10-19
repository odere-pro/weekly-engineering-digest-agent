import { describe, expect, expectTypeOf, it } from 'vitest';
import { redactMessage, redactNote, type FieldRules } from './deliveryFields';
import { createRedactor, REDACTED } from '../../observability/redact';
import type { DigestMessage, DigestView, FailureNote } from '../../delivery/Delivery';

const SECRET = 'smtp-password-4f9a';
const redactor = createRedactor([SECRET]);

const VIEW: DigestView = {
  weekId: '2026-W42',
  title: `Week ${SECRET}`,
  headline: `Headline ${SECRET}`,
  groups: [
    {
      urgency: 'act-now',
      label: `Label ${SECRET}`,
      items: [
        {
          title: `Title ${SECRET}`,
          url: `https://example.test/r?token=${SECRET}`,
          whatChanged: `Changed ${SECRET}`,
          action: `Action ${SECRET}`,
        },
      ],
    },
  ],
  footer: `Footer ${SECRET}`,
};

describe('redactMessage', () => {
  const message: DigestMessage = {
    weekId: '2026-W42',
    subject: `Subject ${SECRET}`,
    markdown: `Body ${SECRET}`,
    view: VIEW,
  };

  it('redacts every text field of the message and of its view, down to the item', () => {
    const redacted = redactMessage(message, redactor);

    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(redacted).toEqual({
      weekId: '2026-W42',
      subject: `Subject ${REDACTED}`,
      markdown: `Body ${REDACTED}`,
      view: {
        weekId: '2026-W42',
        title: `Week ${REDACTED}`,
        headline: `Headline ${REDACTED}`,
        groups: [
          {
            urgency: 'act-now',
            label: `Label ${REDACTED}`,
            items: [
              {
                title: `Title ${REDACTED}`,
                url: `https://example.test/r?token=${REDACTED}`,
                whatChanged: `Changed ${REDACTED}`,
                action: `Action ${REDACTED}`,
              },
            ],
          },
        ],
        footer: `Footer ${REDACTED}`,
      },
    });
  });

  it('keeps the ids that code sets (week, urgency), whatever the redactor knows', () => {
    const knowsTheIds = createRedactor(['2026-W42', 'act-now']);

    const redacted = redactMessage(message, knowsTheIds);

    expect(redacted.weekId).toBe('2026-W42');
    expect(redacted.view?.weekId).toBe('2026-W42');
    expect(redacted.view?.groups[0]?.urgency).toBe('act-now');
  });

  it('leaves an absent field absent: no view, no action, no footer', () => {
    const plain: DigestMessage = { weekId: '2026-W42', subject: 's', markdown: 'm' };
    const item = { title: 't', url: 'https://example.test/a', whatChanged: 'c' };
    const noOptionals: DigestView = {
      weekId: '2026-W42',
      title: 't',
      headline: 'h',
      groups: [{ urgency: 'good-to-know', label: 'l', items: [item] }],
    };

    expect(redactMessage(plain, redactor)).toStrictEqual(plain);
    expect(redactMessage({ ...plain, view: noOptionals }, redactor).view).toStrictEqual(
      noOptionals,
    );
  });

  it('drops a field the type does not know, at every level, rather than send it', () => {
    const extra = {
      ...message,
      preheader: SECRET,
      view: {
        ...VIEW,
        subtitle: SECRET,
        groups: [
          { ...VIEW.groups[0], hint: SECRET, items: [{ ...VIEW.groups[0]?.items[0], x: 1 }] },
        ],
      },
    } as unknown as DigestMessage;

    const redacted = redactMessage(extra, redactor);

    expect(JSON.stringify(redacted)).not.toContain('preheader');
    expect(JSON.stringify(redacted)).not.toContain('subtitle');
    expect(JSON.stringify(redacted)).not.toContain('hint');
    expect(JSON.stringify(redacted)).not.toContain('"x"');
  });

  it('is a new message and leaves the given one as it was', () => {
    const redacted = redactMessage(message, redactor);

    expect(redacted).not.toBe(message);
    expect(message.subject).toBe(`Subject ${SECRET}`);
    expect(message.view?.groups[0]?.items[0]?.title).toBe(`Title ${SECRET}`);
  });
});

describe('redactNote', () => {
  it('redacts the message and keeps the week and the step', () => {
    const note: FailureNote = { weekId: '2026-W42', step: 'deliver', message: `Refused ${SECRET}` };

    expect(redactNote(note, redactor)).toEqual({
      weekId: '2026-W42',
      step: 'deliver',
      message: `Refused ${REDACTED}`,
    });
  });

  it('keeps the week and the step, whatever the redactor knows', () => {
    const knowsTheIds = createRedactor(['2026-W42', 'deliver']);
    const note: FailureNote = { weekId: '2026-W42', step: 'deliver', message: 'm' };

    expect(redactNote(note, knowsTheIds)).toEqual(note);
  });

  it('leaves a missing step missing', () => {
    expect(redactNote({ weekId: '2026-W42', message: 'plain' }, redactor)).toStrictEqual({
      weekId: '2026-W42',
      message: 'plain',
    });
  });

  it('drops a field the type does not know', () => {
    const note = { weekId: '2026-W42', message: 'm', detail: SECRET } as FailureNote;

    expect(JSON.stringify(redactNote(note, redactor))).not.toContain(SECRET);
  });
});

describe('FieldRules', () => {
  it('needs a rule for every field, optional ones too, so a new field does not compile without one', () => {
    const keep = (value: string): string => value;

    expectTypeOf({ weekId: keep, step: keep, message: keep }).toExtend<FieldRules<FailureNote>>();
    expectTypeOf({ weekId: keep, message: keep }).not.toExtend<FieldRules<FailureNote>>();
  });
});
