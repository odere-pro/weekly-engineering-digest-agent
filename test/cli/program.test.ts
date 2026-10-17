import { describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';

describe('CLI program', () => {
  it('registers every spec command', () => {
    const names = buildProgram(() => undefined).commands.map((c) => c.name());
    expect(names).toEqual(['init', 'doctor', 'run', 'eval', 'history', 'feedback', 'serve']);
  });

  it('passes the global --config and command flags to the handler', async () => {
    const codes: number[] = [];
    const program = buildProgram((code) => codes.push(code)).exitOverride();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await program.parseAsync(['node', 'digest', '--config', 'x.json', 'run', '--dry-run'], {
      from: 'node',
    });
    expect(codes).toEqual([1]); // config missing -> DigestError, exit code 1
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('x.json'));
    stderr.mockRestore();
  });

  it('passes the week argument of feedback to its handler', async () => {
    const codes: number[] = [];
    const program = buildProgram((code) => codes.push(code)).exitOverride();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await program.parseAsync(['node', 'digest', 'feedback', '2026-W43'], { from: 'node' });
    expect(codes).toEqual([1]); // the stub handler exits 1 until W7-07 lands
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('2026-W43'));
    stderr.mockRestore();
  });

  it('rejects a non-numeric --limit', async () => {
    const program = buildProgram(() => undefined).exitOverride();
    for (const command of program.commands)
      command.exitOverride().configureOutput({ writeErr: () => undefined });
    await expect(
      program.parseAsync(['node', 'digest', 'history', '--limit', 'x']),
    ).rejects.toThrow();
  });
});
