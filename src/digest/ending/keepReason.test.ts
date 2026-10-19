import { describe, expect, it } from 'vitest';
import { KEPT_PARTLY_REASON, KEPT_SENT_REASON, keepReason, reachedAChannel } from './keepReason';
import type { RunRecord } from '../../store/runRecord';
import { partly, record } from './__fixtures__/endingKit';

describe('reachedAChannel', () => {
  it.each<[string, RunRecord | undefined, boolean]>([
    ['no record', undefined, false],
    ['a failed record that reached no channel', record({ status: 'failed' }), false],
    [
      'a failed record with an empty channel list',
      record({ status: 'failed', deliveredTo: [] }),
      false,
    ],
    ['a sent record', record({ status: 'sent' }), true],
    ['a partly delivered record', partly, true],
  ])('says whether %s reached a channel', (_name, given, expected) => {
    expect(reachedAChannel(given)).toBe(expected);
  });
});

describe('keepReason', () => {
  it.each<[string, RunRecord | undefined, RunRecord, string | undefined]>([
    ['no earlier record', undefined, record({ status: 'quiet' }), undefined],
    ['an earlier record that reached nothing', record({ status: 'failed' }), partly, undefined],
    ['a sent week, sent again', record({ status: 'sent' }), record({ status: 'sent' }), undefined],
    ['a sent week, failed on a forced run', record({ status: 'sent' }), partly, KEPT_SENT_REASON],
    [
      'a sent week, a dry run',
      record({ status: 'sent' }),
      record({ status: 'dry-run' }),
      KEPT_SENT_REASON,
    ],
    [
      'a partly delivered week, a run that reached no channel',
      partly,
      record({ status: 'failed' }),
      KEPT_PARTLY_REASON,
    ],
    [
      'a partly delivered week, a run that reached another channel',
      partly,
      record({ status: 'failed', deliveredTo: ['email'] }),
      undefined,
    ],
    ['a partly delivered week, sent', partly, record({ status: 'sent' }), undefined],
  ])('for %s', (_name, previous, next, expected) => {
    expect(keepReason(previous, next)).toBe(expected);
  });
});
