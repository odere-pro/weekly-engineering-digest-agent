// Test kit for the init folders: a scripted user and an in-memory machine that `initCommand` and the
// subfeatures run against. Not product code; coverage skips `__fixtures__/`.
import { parseEnv } from 'node:util';
import { vi } from 'vitest';
import { fixedClock } from '../../../shared/clock';
import type { InitIo, InitPrompts, Validate, ValidateSelection } from '../types';

export const GIB = 1024 ** 3;
export const CONFIG_PATH = '/work/digest.config.json';
export const ENV_PATH = '/work/.env';
/** A Wednesday in ISO week 2026-W43, whose Monday is 2026-10-19. */
const NOW = '2026-10-21T10:00:00Z';
export const SCHEDULE = {
  path: '/etc/systemd/user/digest.timer',
  content: '[Timer]\nOnCalendar=Mon 07:45\n',
  installHint: 'systemctl --user enable --now digest.timer',
};

type PromptKind = 'confirm' | 'checkbox' | 'input' | 'select' | 'password';
export interface PromptCall {
  kind: PromptKind;
  message: string;
  options: {
    default?: unknown;
    /** A text prompt's `Validate` or a checkbox's `ValidateSelection`: the call is told which by its kind. */
    validate?: Validate & ValidateSelection;
    choices?: readonly { name: string; value: string; checked?: boolean; description?: string }[];
  };
}
/** A message pattern and the answer the scripted user gives to the prompt it matches. */
export type Rule = readonly [RegExp, unknown];

/**
 * A scripted user. A prompt without a matching rule behaves like pressing Enter (the default,
 * or the pre-checked choices); an answer that fails the prompt's own validate() fails the test.
 * A checkbox answer is a list of values, checked as the ticked choices.
 */
export function scriptedPrompts(rules: readonly Rule[] = []): {
  prompts: InitPrompts;
  calls: PromptCall[];
} {
  const calls: PromptCall[] = [];
  const answer = (
    kind: PromptKind,
    options: PromptCall['options'] & { message: string },
  ): unknown => {
    calls.push({ kind, message: options.message, options });
    const rule = rules.find(([pattern]) => pattern.test(options.message));
    const value = rule ? rule[1] : pressEnter(kind, options);
    const verdict = verdictOn(options.validate, value);
    if (verdict !== true) {
      throw new Error(`"${options.message}" rejected ${JSON.stringify(value)}: ${verdict}`);
    }
    return value;
  };
  const prompts = {
    confirm: (o: never) => Promise.resolve(answer('confirm', o)),
    checkbox: (o: never) => Promise.resolve(answer('checkbox', o)),
    input: (o: never) => Promise.resolve(answer('input', o)),
    select: (o: never) => Promise.resolve(answer('select', o)),
    password: (o: never) => Promise.resolve(answer('password', o)),
  } as unknown as InitPrompts;
  return { prompts, calls };
}

/** What the prompt's own validate() says about an answer; true when it has none or the answer is no text or list. */
function verdictOn(validate: PromptCall['options']['validate'], value: unknown): true | string {
  if (validate === undefined) return true;
  if (typeof value === 'string') return validate(value);
  if (Array.isArray(value)) return validate(value.map((picked: string) => ({ value: picked })));
  return true;
}

function pressEnter(
  kind: PromptKind,
  options: PromptCall['options'] & { message: string },
): unknown {
  switch (kind) {
    case 'checkbox':
      return (options.choices ?? []).filter((c) => c.checked).map((c) => c.value);
    case 'input':
      return typeof options.default === 'string' ? options.default : '';
    case 'password':
      throw new Error(`no answer scripted for "${options.message}"`);
    default:
      return options.default;
  }
}

export interface Harness {
  io: InitIo;
  files: Map<string, { content: string; secret: boolean }>;
  calls: PromptCall[];
  out: string[];
  err: string[];
  renderSchedule: ReturnType<typeof vi.fn<InitIo['renderSchedule']>>;
}

export interface HarnessOptions {
  rules?: readonly Rule[];
  existing?: readonly string[];
  /** Files that exist with no content, like the ones `make docker-init` creates. */
  empty?: readonly string[];
  /** The zone this process runs in. */
  timeZone?: string;
  /** What the clock says now; default `NOW`. */
  now?: string;
  /** The folder init runs from; default /work. */
  cwd?: string;
  inDocker?: boolean;
  env?: Record<string, string>;
  ramGiB?: number;
  /** Bytes the container is limited to; 0 or unset when it has no limit. */
  memoryLimitGiB?: number;
  platform?: NodeJS.Platform;
  prompts?: InitPrompts;
  /** The text of an .env that already exists. */
  envText?: string;
  /** Makes reading the existing .env fail. */
  envReadError?: Error;
}

/** An in-memory machine: files live in `files`, prompts follow `rules`, output lands in `out`/`err`. */
export function harness(options: HarnessOptions = {}): Harness {
  const files = new Map<string, { content: string; secret: boolean }>();
  const emptyFiles = new Set(options.empty ?? []);
  const preexisting = new Set([
    ...(options.existing ?? []),
    ...(options.envText === undefined ? [] : [ENV_PATH]),
    ...emptyFiles,
  ]);
  const scripted = scriptedPrompts(options.rules);
  const out: string[] = [];
  const err: string[] = [];
  const renderSchedule = vi.fn<InitIo['renderSchedule']>(() => SCHEDULE);
  const io: InitIo = {
    prompts: options.prompts ?? scripted.prompts,
    env: options.env ?? {},
    platform: options.platform ?? 'linux',
    totalMemoryBytes: (options.ramGiB ?? 32) * GIB,
    memoryLimitBytes: (options.memoryLimitGiB ?? 0) * GIB,
    timeZone: options.timeZone ?? 'Europe/Berlin',
    clock: fixedClock(options.now ?? NOW),
    cwd: options.cwd ?? '/work',
    envPath: ENV_PATH,
    scheduleProgram: '/usr/local/bin/digest',
    renderSchedule,
    exists: (path) =>
      Promise.resolve(
        preexisting.has(path) || files.has(path) || (path === '/.dockerenv' && !!options.inDocker),
      ),
    isEmptyFile: (path) => Promise.resolve(emptyFiles.has(path) && !files.has(path)),
    readFile: (path) => {
      if (path === ENV_PATH && options.envReadError) return Promise.reject(options.envReadError);
      const written = files.get(path);
      if (written) return Promise.resolve(written.content);
      if (path === ENV_PATH && options.envText !== undefined)
        return Promise.resolve(options.envText);
      return Promise.resolve(preexisting.has(path) ? '' : undefined);
    },
    writeFile: (path, content) => {
      files.set(path, { content, secret: false });
      return Promise.resolve();
    },
    writeSecretFile: (path, content) => {
      files.set(path, { content, secret: true });
      return Promise.resolve();
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { io, files, calls: scripted.calls, out, err, renderSchedule };
}

export function writtenConfig(h: Harness): Record<string, unknown> {
  const file = h.files.get(CONFIG_PATH);
  if (!file) throw new Error('digest.config.json was not written');
  return JSON.parse(file.content) as Record<string, unknown>;
}

export function writtenEnvText(h: Harness): string {
  const file = h.files.get(ENV_PATH);
  if (!file) throw new Error('.env was not written');
  return file.content;
}

export function writtenEnv(h: Harness): Record<string, string | undefined> {
  return parseEnv(writtenEnvText(h));
}

/** The answers that pick email delivery and fill its prompts. */
export const EMAIL_RULES: readonly Rule[] = [
  [/Deliver the digest/, ['markdown', 'email']],
  [/SMTP host/, 'smtp.example.com'],
  [/SMTP user/, 'digest@example.com'],
  [/Recipients/, 'ana@example.com, bo@example.com'],
  [/SMTP password/, 'smtp-secret'],
];
/** The answers that pick Slack delivery and fill its prompt. */
export const SLACK_RULES: readonly Rule[] = [
  [/Deliver the digest/, ['markdown', 'slack']],
  [/Slack webhook/, 'https://hooks.slack.com/services/T000/B000/hook-secret'],
];

/** The validate() a text prompt was given, for the first prompt whose message matches. */
export function validatorFor(calls: readonly PromptCall[], pattern: RegExp): Validate {
  return validateOf(calls, pattern);
}

/** The validate() a checkbox question was given, for the first prompt whose message matches. */
export function selectionValidatorFor(
  calls: readonly PromptCall[],
  pattern: RegExp,
): ValidateSelection {
  return validateOf(calls, pattern);
}

function validateOf(calls: readonly PromptCall[], pattern: RegExp): Validate & ValidateSelection {
  const validate = calls.find((c) => pattern.test(c.message))?.options.validate;
  if (!validate) throw new Error(`no validate for ${String(pattern)}`);
  return validate;
}
