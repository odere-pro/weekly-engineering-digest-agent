import { describe, expect, it } from 'vitest';
import { ShowError } from './showError';
import { ExitCode } from '../../domain/schemas';
import { DigestError } from '../../shared/errors';

describe('ShowError', () => {
  it('is a DigestError that keeps its message as it is and exits with code 1', () => {
    const error = new ShowError('No saved run for 2026-W42');
    expect(error).toBeInstanceOf(DigestError);
    expect(error.message).toBe('No saved run for 2026-W42');
    expect(error.exitCode).toBe(ExitCode.Failed);
  });
});
