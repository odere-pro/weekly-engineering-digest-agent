import { describe, expect, it } from 'vitest';
import { DigestBodySchema, WrittenItemSchema } from './writerSchema';

const item = {
  itemId: 'item-1',
  title: 'Runner 2.4 adds GPU runners',
  url: 'https://example.com/runner/2.4',
  area: 'Platform engineering',
  summary: 'Runner 2.4 starts a fresh GPU runner per job.',
  whyItMatters: 'Teams can run evals in CI without idle machines.',
  urgency: 'worth-a-look',
  action: 'Relevant if you run evals in CI.',
};
const body = { headline: 'Runners moved', intro: 'Platform tooling changed.', items: [item] };

describe('WrittenItemSchema', () => {
  it('accepts a complete item', () => {
    expect(WrittenItemSchema.parse(item)).toEqual(item);
  });

  it.each([
    ['a missing url', { url: undefined }],
    ['a null url', { url: null }],
    ['a url that is not a valid url, which the step replaces anyway', { url: 'not a url' }],
    ['an empty action, which good-to-know carries', { action: '' }],
    [
      'an action longer than the digest allows, which the format check judges',
      { action: 'x'.repeat(500) },
    ],
  ])('accepts %s', (_name, patch) => {
    expect(WrittenItemSchema.safeParse({ ...item, ...patch }).success).toBe(true);
  });

  it.each(['urgency', 'action'] as const)('requires %s', (field) => {
    const { [field]: _dropped, ...rest } = item;

    expect(WrittenItemSchema.safeParse(rest).success).toBe(false);
  });

  it('allows only the three urgency values', () => {
    expect(WrittenItemSchema.safeParse({ ...item, urgency: 'urgent' }).success).toBe(false);
    for (const urgency of ['act-now', 'worth-a-look', 'good-to-know']) {
      expect(WrittenItemSchema.safeParse({ ...item, urgency }).success).toBe(true);
    }
  });

  it('still requires the item id and the text fields', () => {
    for (const field of ['itemId', 'title', 'area', 'summary', 'whyItMatters'] as const) {
      expect(WrittenItemSchema.safeParse({ ...item, [field]: '' }).success).toBe(false);
    }
  });
});

describe('DigestBodySchema', () => {
  it('accepts a body with one item and no week', () => {
    expect(DigestBodySchema.parse(body)).toEqual(body);
  });

  it('drops a weekId the model sends, since the step sets the week', () => {
    const parsed = DigestBodySchema.parse({ ...body, weekId: '2020-W01' });

    expect(parsed).not.toHaveProperty('weekId');
  });

  it('needs at least one item, a headline and an intro', () => {
    expect(DigestBodySchema.safeParse({ ...body, items: [] }).success).toBe(false);
    expect(DigestBodySchema.safeParse({ ...body, headline: '' }).success).toBe(false);
    expect(DigestBodySchema.safeParse({ ...body, intro: '' }).success).toBe(false);
  });

  it('holds each item to the written-item rules', () => {
    const { action: _dropped, ...withoutAction } = item;

    expect(DigestBodySchema.safeParse({ ...body, items: [withoutAction] }).success).toBe(false);
  });
});
