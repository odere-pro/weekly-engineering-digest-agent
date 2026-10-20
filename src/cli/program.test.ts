import { beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from './doctor/doctor';
import { evalCommand } from './eval/eval';
import { feedbackCommand } from './feedback/feedback';
import { fetchCommand } from './fetch/fetch';
import { historyCommand } from './history/history';
import { initCommand } from './init/init';
import { buildProgram } from './program';
import { previewCommand } from './preview/preview';
import { runCommand } from './run/run';
import { serveCommand } from './serve/serve';
import { showCommand } from './show/show';

// Every handler is replaced, so these tests see exactly what commander hands over: the compiler
// does not check the `.action(async (options: {...}))` annotations in program.ts, and renaming a
// flag there (`--out` to `--output`) would keep the whole suite green without this table.
vi.mock('./doctor/doctor', () => ({ doctorCommand: vi.fn() }));
vi.mock('./eval/eval', () => ({ evalCommand: vi.fn() }));
vi.mock('./feedback/feedback', () => ({ feedbackCommand: vi.fn() }));
vi.mock('./fetch/fetch', () => ({ fetchCommand: vi.fn() }));
vi.mock('./history/history', () => ({ historyCommand: vi.fn() }));
vi.mock('./init/init', () => ({ initCommand: vi.fn() }));
vi.mock('./preview/preview', () => ({ previewCommand: vi.fn() }));
vi.mock('./run/run', () => ({ runCommand: vi.fn() }));
vi.mock('./serve/serve', () => ({ serveCommand: vi.fn() }));
vi.mock('./show/show', () => ({ showCommand: vi.fn() }));

const DEFAULT_CONFIG = 'digest.config.json';

interface Handler {
  mock: { calls: readonly (readonly unknown[])[] };
  mockResolvedValue: (code: number) => unknown;
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  init: vi.mocked(initCommand),
  doctor: vi.mocked(doctorCommand),
  run: vi.mocked(runCommand),
  eval: vi.mocked(evalCommand),
  fetch: vi.mocked(fetchCommand),
  show: vi.mocked(showCommand),
  preview: vi.mocked(previewCommand),
  history: vi.mocked(historyCommand),
  feedback: vi.mocked(feedbackCommand),
  serve: vi.mocked(serveCommand),
};

beforeEach(() => {
  for (const handler of Object.values(HANDLERS)) handler.mockResolvedValue(0);
});

/** The command line as `index.ts` would receive it after "node digest". */
function argvOf(args: readonly string[]): string[] {
  return ['node', 'digest', ...args];
}

/** A program that throws instead of exiting and keeps commander's messages out of the test output. */
function quietProgram(setExitCode: (code: number) => void = () => undefined) {
  const errors: string[] = [];
  const program = buildProgram(setExitCode).exitOverride();
  program.configureOutput({ writeErr: (text) => errors.push(text), writeOut: () => undefined });
  for (const command of program.commands) {
    command
      .exitOverride()
      .configureOutput({ writeErr: (text) => errors.push(text), writeOut: () => undefined });
  }
  return { program, errors };
}

/** Runs `digest <args>`; resolves to the options object the command's handler received. */
async function optionsReaching(command: string, args: readonly string[]): Promise<unknown> {
  const handler = HANDLERS[command];
  if (handler === undefined) throw new Error(`no handler for ${command}`);
  await quietProgram().program.parseAsync(argvOf(args), { from: 'node' });
  expect(handler.mock.calls, `${command} called once`).toHaveLength(1);
  const [call] = handler.mock.calls;
  expect(call, 'handler gets the options alone').toHaveLength(1);
  return call?.[0];
}

/** The text commander printed when it refused `digest <args>`, with no handler called. */
async function refusal(args: readonly string[]): Promise<string> {
  const { program, errors } = quietProgram();
  await expect(program.parseAsync(argvOf(args), { from: 'node' })).rejects.toThrow();
  for (const handler of Object.values(HANDLERS)) expect(handler.mock.calls).toEqual([]);
  return errors.join('');
}

describe('CLI program', () => {
  it('registers every spec command', () => {
    const names = buildProgram(() => undefined).commands.map((c) => c.name());
    expect(names).toEqual(Object.keys(HANDLERS));
  });

  it('offers --only, --resume and --compare on eval (W11-08)', () => {
    const evalProgram = buildProgram(() => undefined).commands.find((c) => c.name() === 'eval')!;
    expect(evalProgram.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--profile', '--only', '--resume', '--compare']),
    );
  });
});

/** One argv per command and per flag, and the options its handler must receive. */
const FLAG_CASES: readonly (readonly [command: string, args: string[], options: object])[] = [
  ['init', ['init'], {}],
  ['init', ['init', '--yes'], { yes: true }],
  ['init', ['init', '-y'], { yes: true }],

  ['doctor', ['doctor'], {}],
  ['doctor', ['doctor', '--readiness'], { readiness: true }],

  ['run', ['run'], {}],
  ['run', ['run', '--since', '14d'], { since: '14d' }],
  ['run', ['run', '--dry-run'], { dryRun: true }],
  ['run', ['run', '--force'], { force: true }],
  ['run', ['run', '--seed', '7'], { seed: 7 }],
  ['run', ['run', '--seed', '0'], { seed: 0 }],
  ['run', ['run', '--out', './digests'], { out: './digests' }],
  [
    'run',
    ['run', '--since', '3d', '--dry-run', '--force', '--seed', '9', '--out', 'out'],
    { since: '3d', dryRun: true, force: true, seed: 9, out: 'out' },
  ],
  ['run', ['run', '--enrich'], { enrich: true }],
  ['run', ['run', '--complete'], { complete: true }],
  ['run', ['run', '--perspective', 'supply chain'], { perspective: 'supply chain' }],
  [
    'run',
    ['run', '--add-source', 'https://a.example/feed.xml', 'https://github.com/o/r'],
    { addSource: ['https://a.example/feed.xml', 'https://github.com/o/r'] },
  ],
  [
    'run',
    ['run', '--dry-run', '--perspective', 'security', '--since', '7d'],
    { dryRun: true, perspective: 'security', since: '7d' },
  ],

  ['eval', ['eval'], {}],
  ['eval', ['eval', '--profile', 'light'], { profile: 'light' }],
  ['eval', ['eval', '--profile', 'all'], { profile: 'all' }],
  ['eval', ['eval', '--only', 'guards'], { only: 'guards' }],
  ['eval', ['eval', '--resume'], { resume: true }],
  ['eval', ['eval', '--compare', 'a.json', 'b.json'], { compare: ['a.json', 'b.json'] }],
  [
    'eval',
    ['eval', '--profile', 'fast', '--only', 'weeks', '--resume'],
    { profile: 'fast', only: 'weeks', resume: true },
  ],

  ['fetch', ['fetch'], {}],
  ['fetch', ['fetch', '--source', 'a'], { source: ['a'] }],
  ['fetch', ['fetch', '--source', 'a', 'b'], { source: ['a', 'b'] }],
  ['fetch', ['fetch', '--source', 'a', '--source', 'b'], { source: ['a', 'b'] }],
  ['fetch', ['fetch', '--since', '2d'], { since: '2d' }],
  ['fetch', ['fetch', '--out', './data'], { out: './data' }],
  [
    'fetch',
    ['fetch', '--since', '5d', '--out', 'd', '--source', 'x', 'y'],
    { since: '5d', out: 'd', source: ['x', 'y'] },
  ],

  ['show', ['show', '2026-W42'], { week: '2026-W42' }],
  ['show', ['show', '2026-W42', '--part', 'items'], { week: '2026-W42', part: 'items' }],
  ['show', ['show', '2026-W42', '--json'], { week: '2026-W42', json: true }],
  [
    'show',
    ['show', '--json', '--part', 'digest', '2026-W41'],
    { week: '2026-W41', part: 'digest', json: true },
  ],

  ['preview', ['preview', '2026-W42'], { week: '2026-W42' }],
  [
    'preview',
    ['preview', '2026-W42', '--channel', 'slack'],
    { week: '2026-W42', channel: 'slack' },
  ],
  ['preview', ['preview', '2026-W42', '--out', './p'], { week: '2026-W42', out: './p' }],
  [
    'preview',
    ['preview', '2026-W42', '--channel', 'all', '--out', 'p'],
    { week: '2026-W42', channel: 'all', out: 'p' },
  ],

  ['history', ['history'], {}],
  ['history', ['history', '-n', '5'], { limit: 5 }],
  ['history', ['history', '--limit', '12'], { limit: 12 }],
  ['history', ['history', '--limit', '1'], { limit: 1 }],

  ['feedback', ['feedback', '2026-W43'], { week: '2026-W43' }],

  ['serve', ['serve'], {}],
];

describe('CLI program: flags reach the handler', () => {
  it.each(FLAG_CASES)('digest %s: %j', async (command, args, options) => {
    expect(await optionsReaching(command, args)).toEqual({ ...options, config: DEFAULT_CONFIG });
  });

  it('covers every command, and every flag of every command, in the table', () => {
    const covered = new Set(FLAG_CASES.map(([command]) => command));
    expect([...covered]).toEqual(Object.keys(HANDLERS));

    const program = buildProgram(() => undefined);
    for (const command of program.commands) {
      for (const option of command.options) {
        const used = FLAG_CASES.some(
          ([name, args]) => name === command.name() && args.includes(option.long ?? ''),
        );
        expect(used, `${command.name()} ${option.long}`).toBe(true);
      }
    }
  });
});

describe('CLI program: the global --config', () => {
  const MINIMAL: readonly (readonly [command: string, args: string[]])[] = [
    ['init', ['init']],
    ['doctor', ['doctor']],
    ['run', ['run']],
    ['eval', ['eval']],
    ['fetch', ['fetch']],
    ['show', ['show', '2026-W42']],
    ['preview', ['preview', '2026-W42']],
    ['history', ['history']],
    ['feedback', ['feedback', '2026-W43']],
    ['serve', ['serve']],
  ];

  it('is the default file when it is not given', async () => {
    for (const [command, args] of MINIMAL) {
      expect(await optionsReaching(command, args), command).toMatchObject({
        config: DEFAULT_CONFIG,
      });
    }
  });

  describe.each(MINIMAL)('digest %s', (command, args) => {
    it.each([
      ['before the command, as --config', ['--config', 'a.json', ...args]],
      ['before the command, as -c', ['-c', 'a.json', ...args]],
      ['after the command, as --config', [...args, '--config', 'a.json']],
      ['after the command, as -c', [...args, '-c', 'a.json']],
    ])('takes it %s', async (_where, argv) => {
      expect(await optionsReaching(command, argv)).toMatchObject({ config: 'a.json' });
    });
  });

  it('is passed on together with the command flags and the week, wherever it stands', async () => {
    expect(await optionsReaching('run', ['run', '--dry-run', '-c', 'x.json'])).toEqual({
      dryRun: true,
      config: 'x.json',
    });
    expect(await optionsReaching('show', ['-c', 'x.json', 'show', '2026-W42', '--json'])).toEqual({
      week: '2026-W42',
      json: true,
      config: 'x.json',
    });
  });
});

describe('CLI program: exit codes', () => {
  it.each(Object.keys(HANDLERS))(
    'hands the code that %s returns to setExitCode',
    async (command) => {
      const codes: number[] = [];
      const { program } = quietProgram((code) => codes.push(code));
      HANDLERS[command]?.mockResolvedValue(3);
      const week = ['show', 'preview', 'feedback'].includes(command) ? ['2026-W42'] : [];

      await program.parseAsync(argvOf([command, ...week]), { from: 'node' });

      expect(codes).toEqual([3]);
    },
  );
});

describe('CLI program: values commander refuses', () => {
  it.each([
    ['--seed', ['run', '--seed', 'x'], 'whole number of 0 or more'],
    ['--seed', ['run', '--seed', '-1'], 'whole number of 0 or more'],
    ['--seed', ['run', '--seed', '1.5'], 'whole number of 0 or more'],
    ['--limit', ['history', '--limit', 'x'], 'must be a positive integer'],
    ['--limit', ['history', '--limit', '0'], 'must be a positive integer'],
    ['--limit', ['history', '--limit', '-3'], 'must be a positive integer'],
    ['--limit', ['history', '--limit', '2.5'], 'must be a positive integer'],
    ['-n', ['history', '-n', 'x'], 'must be a positive integer'],
  ])('%s: %j says "%s"', async (flag, args, message) => {
    const text = await refusal(args);

    expect(text).toContain(`argument '`);
    expect(text).toContain(message);
    expect(text).toContain(flag);
  });

  it.each([
    ['run', ['run', '--nope']],
    ['history', ['history', '--nope']],
    ['preview', ['preview', '2026-W42', '--nope']],
  ])('says "unknown option" for a flag %s does not have: %j', async (_command, args) => {
    expect(await refusal(args)).toContain('unknown option');
  });

  it.each(['show', 'preview', 'feedback'])(
    'asks for the week when %s has none',
    async (command) => {
      expect(await refusal([command])).toContain("missing required argument 'week'");
    },
  );
});
