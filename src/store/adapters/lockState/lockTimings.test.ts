import { describe, expect, it } from 'vitest';
import {
  LOCK_HEARTBEAT_INTERVAL_MS,
  LOCK_HEARTBEAT_TIMEOUT_MS,
  LOCK_MAX_AGE_MS,
  ORPHANED_TEMP_MAX_AGE_MS,
  TAKEOVER_GUARD_MAX_AGE_MS,
} from './lockTimings';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

describe('lock timings', () => {
  it('keep the values the operator docs describe', () => {
    expect(LOCK_MAX_AGE_MS).toBe(6 * HOUR_MS);
    expect(TAKEOVER_GUARD_MAX_AGE_MS).toBe(30 * SECOND_MS);
    expect(LOCK_HEARTBEAT_INTERVAL_MS).toBe(MINUTE_MS);
    expect(LOCK_HEARTBEAT_TIMEOUT_MS).toBe(5 * MINUTE_MS);
    expect(ORPHANED_TEMP_MAX_AGE_MS).toBe(10 * MINUTE_MS);
  });

  it('let a holder miss two beats before its lock counts as abandoned', () => {
    expect(LOCK_HEARTBEAT_INTERVAL_MS * 3).toBeLessThan(LOCK_HEARTBEAT_TIMEOUT_MS);
  });

  it('let a takeover guard expire long before a lock does', () => {
    expect(TAKEOVER_GUARD_MAX_AGE_MS).toBeLessThan(LOCK_HEARTBEAT_TIMEOUT_MS);
  });
});
