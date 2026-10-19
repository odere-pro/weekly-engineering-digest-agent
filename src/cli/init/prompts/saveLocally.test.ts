import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../../shared/clock';
import {
  localFolder,
  requireSaveLocally,
  SAVE_LOCALLY,
  SAVE_LOCALLY_REQUIRED,
  saveLocallyChoice,
} from './saveLocally';

const WEDNESDAY = '2026-10-21T10:00:00Z'; // ISO week 2026-W43, Monday 2026-10-19

const where = (overrides: Partial<Parameters<typeof localFolder>[1]> = {}) => ({
  timeZone: 'Europe/Berlin',
  inDocker: false,
  ...overrides,
});

const at = (now: string, cwd = '/work') => ({ cwd, clock: fixedClock(now) });

describe('localFolder', () => {
  it('is the absolute week folder below the default data folder, ending in a slash', () => {
    expect(localFolder(at(WEDNESDAY), where())).toBe('/work/dist/2026-10-19/digest/');
  });

  it('is the folder of the Monday of the clock’s week, whatever day it is', () => {
    expect(localFolder(at('2026-10-19T00:30:00Z'), where())).toBe('/work/dist/2026-10-19/digest/');
    expect(localFolder(at('2026-10-25T20:00:00Z'), where())).toBe('/work/dist/2026-10-19/digest/');
    expect(localFolder(at('2026-10-26T08:00:00Z'), where())).toBe('/work/dist/2026-10-26/digest/');
  });

  it('is the Monday of the ISO week, also across the turn of the year', () => {
    expect(localFolder(at('2027-01-01T10:00:00Z'), where())).toBe('/work/dist/2026-12-28/digest/');
    expect(localFolder(at('2024-12-31T10:00:00Z'), where())).toBe('/work/dist/2024-12-30/digest/');
  });

  it('counts the week in the schedule time zone, as the run does', () => {
    const sundayNight = at('2026-10-18T23:30:00Z');

    expect(localFolder(sundayNight, where({ timeZone: 'Europe/Berlin' }))).toBe(
      '/work/dist/2026-10-19/digest/',
    );
    expect(localFolder(sundayNight, where({ timeZone: 'UTC' }))).toBe(
      '/work/dist/2026-10-12/digest/',
    );
  });

  it('counts the week in UTC for a zone nobody knows: the config check reports that zone later', () => {
    const sundayNight = at('2026-10-18T23:30:00Z');

    expect(localFolder(sundayNight, where({ timeZone: '' }))).toBe('/work/dist/2026-10-12/digest/');
    expect(localFolder(sundayNight, where({ timeZone: 'Mars/Olympus' }))).toBe(
      '/work/dist/2026-10-12/digest/',
    );
  });

  it('is resolved against the folder digest runs from', () => {
    expect(localFolder(at(WEDNESDAY, '/srv/engineering digest'), where())).toBe(
      '/srv/engineering digest/dist/2026-10-19/digest/',
    );
  });

  it('follows the data folder it is given, relative to the working folder or absolute', () => {
    expect(localFolder(at(WEDNESDAY), where({ dataDir: 'runs/weekly' }))).toBe(
      '/work/runs/weekly/2026-10-19/digest/',
    );
    expect(localFolder(at(WEDNESDAY), where({ dataDir: '/var/lib/digest' }))).toBe(
      '/var/lib/digest/2026-10-19/digest/',
    );
    expect(localFolder(at(WEDNESDAY), where({ dataDir: './dist/' }))).toBe(
      '/work/dist/2026-10-19/digest/',
    );
  });

  it('is the ./dist folder on the host inside Docker, where /app/dist is a mount', () => {
    expect(localFolder(at(WEDNESDAY, '/app'), where({ inDocker: true }))).toBe(
      './dist/2026-10-19/digest/ on the host',
    );
  });
});

describe('saveLocallyChoice', () => {
  it('is ticked, and its label names the folder', () => {
    expect(saveLocallyChoice('/work/dist/2026-10-19/digest/')).toEqual({
      name: 'Save locally (Markdown and HTML): /work/dist/2026-10-19/digest/',
      value: SAVE_LOCALLY,
      checked: true,
    });
  });
});

describe('requireSaveLocally', () => {
  it('accepts a selection that has it, with or without the other channels', () => {
    expect(requireSaveLocally([{ value: SAVE_LOCALLY }])).toBe(true);
    expect(requireSaveLocally([{ value: SAVE_LOCALLY }, { value: 'email' }])).toBe(true);
    expect(requireSaveLocally([{ value: 'slack' }, { value: SAVE_LOCALLY }])).toBe(true);
  });

  it.each([[[]], [[{ value: 'email' }]], [[{ value: 'email' }, { value: 'slack' }]]])(
    'refuses %j with the reason that saving locally is always on',
    (selected) => {
      expect(requireSaveLocally(selected)).toBe(SAVE_LOCALLY_REQUIRED);
      expect(SAVE_LOCALLY_REQUIRED).toMatch(/always on/);
    },
  );
});
