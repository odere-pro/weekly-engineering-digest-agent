import { describe, expect, it } from 'vitest';
import { fail, ok, warn } from './checkResult';

describe('check results', () => {
  it('ok has no fix line', () => {
    expect(ok('guards', 'all guards on')).toEqual({
      severity: 'ok',
      label: 'guards',
      message: 'all guards on',
    });
  });

  it('warn carries a fix and the warn severity', () => {
    expect(warn('.env', 'readable by other users', 'chmod 600 .env')).toEqual({
      severity: 'warn',
      label: '.env',
      message: 'readable by other users',
      fix: 'chmod 600 .env',
    });
  });

  it('fail carries a fix and the error severity', () => {
    expect(fail('config', 'bad', 'run "digest init"')).toEqual({
      severity: 'error',
      label: 'config',
      message: 'bad',
      fix: 'run "digest init"',
    });
  });
});
