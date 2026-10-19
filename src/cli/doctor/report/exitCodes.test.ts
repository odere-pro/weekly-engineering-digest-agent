import { describe, expect, it } from 'vitest';
import { EXIT_FAILED, EXIT_NONE_FIT, EXIT_OK } from './exitCodes';

// Exit codes are public (scripts and the scheduler read them): this pins the numbers.
describe('doctor exit codes', () => {
  it('uses 0 for success and 1 for a failed check or no profile that fits', () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_FAILED).toBe(1);
    expect(EXIT_NONE_FIT).toBe(1);
  });
});
