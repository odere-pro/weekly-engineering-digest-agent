// CLI wiring. Every command is registered here once (Wave 0); issues implement the handlers.
import { Command, InvalidArgumentError } from 'commander';
import { doctorCommand } from './doctor.js';
import { evalCommand } from './eval.js';
import { feedbackCommand } from './feedback.js';
import { historyCommand } from './history.js';
import { initCommand } from './init.js';
import { runCommand } from './run.js';
import { serveCommand } from './serve.js';

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

function nonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new InvalidArgumentError('must be a whole number of 0 or more');
  return n;
}

/** Builds the program. `setExitCode` receives each command's exit code. */
export function buildProgram(setExitCode: (code: number) => void): Command {
  const program = new Command()
    .name('digest')
    .description('Weekly digest of the AI and platform engineering releases that matter.')
    .option('-c, --config <path>', 'path to digest.config.json', 'digest.config.json')
    .showHelpAfterError();

  const withConfig = <T extends object>(options: T): T & { config?: string } => ({
    ...options,
    config: program.opts<{ config?: string }>().config,
  });

  program
    .command('init')
    .description('ask for focus areas, delivery and profile; write digest.config.json and .env')
    .option('-y, --yes', 'accept defaults without prompting')
    .action(async (options: { yes?: boolean }) => {
      setExitCode(await initCommand(withConfig(options)));
    });

  program
    .command('doctor')
    .description('check Ollama, the models, every feed and delivery; print what to fix')
    .option('--readiness', 'print the machine summary and a verdict for every profile')
    .action(async (options: { readiness?: boolean }) => {
      setExitCode(await doctorCommand(withConfig(options)));
    });

  program
    .command('run')
    .description('one full run (exit codes: 0 sent, 1 failed, 2 blocked, 3 quiet week)')
    .option('--since <window>', 'collection window, e.g. 7d')
    .option('--dry-run', 'write the digest to disk and send nothing')
    .option('--force', 'run even if this week already has a sent digest')
    .option('--seed <n>', 'sampling seed for this run (overrides models.seed)', nonNegativeInt)
    .action(
      async (options: { since?: string; dryRun?: boolean; force?: boolean; seed?: number }) => {
        setExitCode(await runCommand(withConfig(options)));
      },
    );

  program
    .command('eval')
    .description('run the eval set and print the scorecard')
    .option('--profile <name>', 'profile name, or "all"')
    .action(async (options: { profile?: string }) => {
      setExitCode(await evalCommand(withConfig(options)));
    });

  program
    .command('history')
    .description('list past runs with status, item counts and duration')
    .option('-n, --limit <count>', 'number of runs', positiveInt)
    .action(async (options: { limit?: number }) => {
      setExitCode(await historyCommand(withConfig(options)));
    });

  program
    .command('feedback')
    .description('turn the ticks in data/runs/<week>/review.md into eval labels')
    .argument('<week>', 'ISO week id, for example 2026-W43')
    .action(async (week: string) => {
      setExitCode(await feedbackCommand(withConfig({ week })));
    });

  program
    .command('serve')
    .description('run the weekly scheduler in the foreground (Docker Compose service)')
    .action(async () => {
      setExitCode(await serveCommand(withConfig({})));
    });

  return program;
}
