import { describe, expect, it } from 'vitest';
import {
  KEPT_OTHER_RUN_REASON,
  KEPT_PARTLY_REASON,
  KEPT_SENT_REASON,
  deliveredMeanwhile,
  keepReason,
  reachedAChannel,
} from './keepReason';
import type { RunRecord } from '../../store/runRecord';
import { partly, record, sent } from './__fixtures__/endingKit';

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

describe('deliveredMeanwhile', () => {
  const emailOnly = record({ status: 'failed', deliveredTo: ['email'] });
  const both = record({ status: 'failed', deliveredTo: ['markdown', 'email'] });

  it.each<[string, RunRecord | undefined, RunRecord | undefined, boolean]>([
    ['no record, then none', undefined, undefined, false],
    ['no record, then a sent one', undefined, sent, true],
    ['no record, then one that reached a channel', undefined, partly, true],
    ['no record, then one that reached nothing', undefined, record({ status: 'failed' }), false],
    ['a failed record, then a sent one', record({ status: 'failed' }), sent, true],
    ['a sent record, then the same one', sent, sent, false],
    ['a partly delivered record, then the same one', partly, partly, false],
    ['a partly delivered record, then one with another channel', partly, both, true],
    ['a partly delivered record, then one with only the same channel', both, partly, false],
    ['a partly delivered record, then another channel alone', partly, emailOnly, true],
    ['a record, then none: it was pruned', sent, undefined, false],
  ])('for %s', (_name, started, stored, expected) => {
    expect(deliveredMeanwhile(started, stored)).toBe(expected);
  });
});

describe('keepReason against the record stored when the run ends', () => {
  it.each<[string, RunRecord | undefined, RunRecord | undefined, RunRecord, string | undefined]>([
    [
      'another run sent the week, this one ended quiet',
      undefined,
      sent,
      record({ status: 'quiet' }),
      KEPT_OTHER_RUN_REASON,
    ],
    [
      'another run sent the week, this one failed',
      undefined,
      sent,
      record({ status: 'failed' }),
      KEPT_OTHER_RUN_REASON,
    ],
    [
      'another run reached a channel, this one reached none',
      undefined,
      partly,
      record({ status: 'failed' }),
      KEPT_OTHER_RUN_REASON,
    ],
    ['another run sent the week, this one sent too', undefined, sent, sent, undefined],
    [
      'another run reached a channel, this one reached another',
      undefined,
      partly,
      record({ status: 'failed', deliveredTo: ['email'] }),
      undefined,
    ],
    [
      'the stored record is what the run started with',
      partly,
      partly,
      record({ status: 'failed' }),
      KEPT_PARTLY_REASON,
    ],
    ['a forced run over a sent week: the sent week stays', sent, sent, partly, KEPT_SENT_REASON],
    ['nothing stored', undefined, undefined, record({ status: 'quiet' }), undefined],
  ])('for %s', (_name, started, stored, next, expected) => {
    expect(keepReason(started, next, stored)).toBe(expected);
  });
});
