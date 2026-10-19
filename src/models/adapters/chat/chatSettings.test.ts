import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPERATURE,
  DEFAULT_THINK,
  effectiveTemperature,
  effectiveThink,
} from './chatSettings';

describe('effectiveThink', () => {
  it('returns the configured setting over the adapter default', () => {
    expect(effectiveThink({ guardRisk: true }, 'guardRisk')).toBe(true);
    expect(effectiveThink({ write: 'high' }, 'write')).toBe('high');
  });

  it('keeps an explicit false instead of falling back to the default', () => {
    expect(effectiveThink({ guardRisk: false, classify: false }, 'classify')).toBe(false);
  });

  it('returns the adapter default for a role without a setting', () => {
    expect(effectiveThink(undefined, 'guardRisk')).toBe(false);
    expect(effectiveThink({ write: 'low' }, 'guardRisk')).toBe(false);
  });

  it('returns undefined when neither the config nor the adapter says anything', () => {
    expect(effectiveThink(undefined, 'classify')).toBeUndefined();
    expect(effectiveThink({}, 'write')).toBeUndefined();
  });

  it('turns thinking off by default for guardRisk only', () => {
    expect(DEFAULT_THINK).toEqual({ guardRisk: false });
  });
});

describe('effectiveTemperature', () => {
  it.each([
    ['write', 0.2],
    ['classify', 0],
    ['guardPolicy', 0],
    ['guardRisk', 0],
    ['judge', 0],
  ] as const)('defaults the %s temperature to %s', (role, temperature) => {
    expect(effectiveTemperature(undefined, role)).toBe(temperature);
    expect(DEFAULT_TEMPERATURE[role]).toBe(temperature);
  });

  it('returns the configured temperature over the default', () => {
    expect(effectiveTemperature({ write: 0.7 }, 'write')).toBe(0.7);
  });

  it('keeps a configured temperature of 0', () => {
    expect(effectiveTemperature({ write: 0 }, 'write')).toBe(0);
  });

  it('falls back to the default for a role the config leaves out', () => {
    expect(effectiveTemperature({ judge: 0.5 }, 'write')).toBe(0.2);
  });
});
