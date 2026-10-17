import { describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';

describe('CLI program', () => {
  it('registers every spec command', () => {
    const names = buildProgram(() => undefined).commands.map((c) => c.name());
    expect(names).toEqual([
      'init',
      'doctor',
      'run',
      'eval',
      'fetch',
      'show',
      'preview',
      'history',
      'feedback',
      'serve',
    ]);
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

  it('passes the global --config and the week argument to feedback', async () => {
    const codes: number[] = [];
    const program = buildProgram((code) => codes.push(code)).exitOverride();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await program.parseAsync(['node', 'digest', '--config', 'x.json', 'feedback', '2026-W43'], {
      from: 'node',
    });
    expect(codes).toEqual([1]); // config missing -> exit code 1
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('x.json'));
    stderr.mockRestore();
  });

  it('offers --seed on run and rejects a value that is not a whole number of 0 or more', async () => {
    const run = buildProgram(() => undefined).commands.find((c) => c.name() === 'run')!;
    expect(run.options.map((o) => o.long)).toContain('--seed');
    for (const bad of ['x', '-1', '1.5']) {
      const program = buildProgram(() => undefined).exitOverride();
      for (const command of program.commands)
        command.exitOverride().configureOutput({ writeErr: () => undefined });
      await expect(program.parseAsync(['node', 'digest', 'run', '--seed', bad])).rejects.toThrow();
    }
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
