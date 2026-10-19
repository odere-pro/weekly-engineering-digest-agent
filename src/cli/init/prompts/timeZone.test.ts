import { describe, expect, it } from 'vitest';
import { harness, type HarnessOptions } from '../__fixtures__/initHarness';
import { askTimeZone, isContainerDefaultZone, isTimeZone } from './timeZone';

/** Asks the zone question on a fake machine; returns the prompt call and what the user ends up with. */
async function ask(options: HarnessOptions = {}, inDocker = options.inDocker ?? false) {
  const h = harness(options);
  const zone = await askTimeZone(h.io, inDocker);
  const call = h.calls.find((c) => /Time zone/.test(c.message));
  if (!call) throw new Error('the time zone was not asked');
  return { call, zone };
}

describe('askTimeZone', () => {
  it('offers the detected zone as the default and returns it on Enter', async () => {
    const { call, zone } = await ask({ timeZone: 'America/Chicago' });

    expect(call.kind).toBe('input');
    expect(call.options.default).toBe('America/Chicago');
    expect(zone).toBe('America/Chicago');
  });

  it('returns the zone the user types, trimmed', async () => {
    const { zone } = await ask({ rules: [[/Time zone/, '  America/New_York ']] });

    expect(zone).toBe('America/New_York');
  });

  it.each(['Mars/Phobos', 'Berlin', '', '   '])('rejects "%s" as a zone', async (typed) => {
    const { call } = await ask();

    expect(call.options.validate?.(typed)).toEqual(expect.stringMatching(/time zone/i));
  });

  it.each(['Europe/Berlin', 'UTC', 'Asia/Kolkata'])('accepts %s as a zone', async (typed) => {
    const { call } = await ask();

    expect(call.options.validate?.(typed)).toBe(true);
  });

  it('accepts a zone with spaces around it, since the answer is trimmed', async () => {
    const { call } = await ask();

    expect(call.options.validate?.('  Europe/Berlin ')).toBe(true);
  });

  it('says in the prompt that a container runs on UTC unless TZ is set', async () => {
    const { call } = await ask({ inDocker: true, timeZone: 'UTC' });

    expect(call.message).toContain('UTC');
    expect(call.message).toContain('TZ');
    expect(call.options.default).toBe('UTC');
  });

  it('says the same for Etc/UTC, the other zone a container reports', async () => {
    const { call } = await ask({ inDocker: true, timeZone: 'Etc/UTC' });

    expect(call.message).toContain('TZ');
  });

  it('keeps the prompt plain outside Docker, even on a UTC machine', async () => {
    const { call } = await ask({ timeZone: 'UTC' });

    expect(call.message).toBe('Time zone for the weekly schedule');
  });

  it('does not blame Docker when TZ already gave the container a real zone', async () => {
    const { call } = await ask({ inDocker: true, timeZone: 'Europe/Berlin' });

    expect(call.message).toBe('Time zone for the weekly schedule');
  });
});

describe('isTimeZone', () => {
  it.each(['Europe/Berlin', 'UTC', 'America/New_York', 'Asia/Kolkata'])('accepts %s', (zone) => {
    expect(isTimeZone(zone)).toBe(true);
  });

  it.each(['Mars/Phobos', 'Berlin', '', 'not a zone'])('refuses %j', (zone) => {
    expect(isTimeZone(zone)).toBe(false);
  });
});

describe('isContainerDefaultZone', () => {
  it.each(['UTC', 'Etc/UTC'])('is true for %s, what a container reports without TZ', (zone) => {
    expect(isContainerDefaultZone(zone)).toBe(true);
  });

  it.each(['Europe/Berlin', 'America/New_York', 'utc', ''])('is false for %j', (zone) => {
    expect(isContainerDefaultZone(zone)).toBe(false);
  });
});
