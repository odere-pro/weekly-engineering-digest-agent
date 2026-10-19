import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DigestError } from '../../../shared/errors';
import { ENV_PATH, harness, type HarnessOptions } from '../__fixtures__/initHarness';
import type { Answers } from '../types';
import { buildEnvFile, envUpdates, readEnvFile, renderEnvFile, secretsOf } from './envText';

const OLLAMA_URL = 'http://localhost:11434';
const BASE: Answers = { profile: 'light', timeZone: 'Europe/Berlin', focusAreas: ['a'] };
const HAND_WRITTEN = [
  '# my settings, written by hand',
  'LOG_LEVEL=debug',
  '',
  'GITHUB_TOKEN="ghp_a token # with a hash"',
  'OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces',
  '',
].join('\n');

const buildOn = (options: HarnessOptions, secrets: Record<string, string> = {}) =>
  buildEnvFile(harness(options).io, OLLAMA_URL, secrets);

describe('renderEnvFile', () => {
  it('writes a header, OLLAMA_URL, the secrets and a commented GITHUB_TOKEN', () => {
    expect(renderEnvFile(OLLAMA_URL, { SMTP_PASSWORD: 'smtp-secret' })).toBe(
      [
        '# Written by "digest init". Keep this file private and out of git.',
        'OLLAMA_URL=http://localhost:11434',
        'SMTP_PASSWORD=smtp-secret',
        '# Optional: a GitHub token raises the API rate limit for release feeds.',
        '# GITHUB_TOKEN=',
        '',
      ].join('\n'),
    );
  });

  it('has no secret lines when there are none', () => {
    expect(renderEnvFile(OLLAMA_URL, {})).not.toMatch(/SMTP_PASSWORD|SLACK_WEBHOOK_URL/);
  });

  it.each(['pa ss#word', `it's "quoted"`, 'back\\nslash', 'x=y $HOME `cmd`'])(
    'stores %j so that the loader reads it back unchanged',
    (password) => {
      const text = renderEnvFile(OLLAMA_URL, { SMTP_PASSWORD: password });

      expect(parseEnv(text)['SMTP_PASSWORD']).toBe(password);
    },
  );

  it('refuses a value that cannot be stored, and does not print it', () => {
    const value = `a'b"c\`d`;
    const attempt = (): string => renderEnvFile(OLLAMA_URL, { SMTP_PASSWORD: value });

    expect(attempt).toThrow(DigestError);
    expect(attempt).toThrow(/SMTP_PASSWORD cannot be stored in \.env/);
    let message = '';
    try {
      attempt();
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).not.toContain(value);
  });
});

describe('secretsOf', () => {
  it('has no secrets for the Markdown-only answers', () => {
    expect(secretsOf(BASE)).toEqual({});
  });

  it('has the SMTP password when email is on', () => {
    const answers: Answers = { ...BASE, email: { delivery: undefined, password: 'smtp-secret' } };

    expect(secretsOf(answers)).toEqual({ SMTP_PASSWORD: 'smtp-secret' });
  });

  it('has the Slack webhook when Slack is on', () => {
    const webhook = 'https://hooks.slack.com/services/T000/B000/hook-secret';

    expect(secretsOf({ ...BASE, slackWebhook: webhook })).toEqual({ SLACK_WEBHOOK_URL: webhook });
  });

  it('has both, email first', () => {
    const answers: Answers = {
      ...BASE,
      email: { delivery: undefined, password: 'p' },
      slackWebhook: 'https://hooks.slack.com/services/x',
    };

    expect(Object.keys(secretsOf(answers))).toEqual(['SMTP_PASSWORD', 'SLACK_WEBHOOK_URL']);
  });

  it('names the key, never the value, of a secret the schema refuses', () => {
    const answers: Answers = { ...BASE, slackWebhook: 'http://leaky.example/secret-path' };

    const attempt = (): unknown => secretsOf(answers);

    expect(attempt).toThrow(DigestError);
    expect(attempt).toThrow('Invalid secret value for SLACK_WEBHOOK_URL, nothing was written.');
    expect(attempt).not.toThrow(/leaky/);
  });

  it('names every refused key', () => {
    const answers: Answers = {
      ...BASE,
      email: { delivery: undefined, password: '' },
      slackWebhook: 'http://leaky.example/x',
    };

    expect(() => secretsOf(answers)).toThrow(
      'Invalid secret value for SMTP_PASSWORD, SLACK_WEBHOOK_URL, nothing was written.',
    );
  });
});

describe('envUpdates', () => {
  it('sets OLLAMA_URL, then the secrets, when the file has no URL', () => {
    expect(envUpdates('LOG_LEVEL=debug\n', OLLAMA_URL, { SMTP_PASSWORD: 'p' })).toEqual([
      { key: 'OLLAMA_URL', value: OLLAMA_URL },
      { key: 'SMTP_PASSWORD', value: 'p' },
    ]);
  });

  it('keeps an OLLAMA_URL that was set by hand', () => {
    expect(envUpdates('OLLAMA_URL=http://gpu-box:11434\n', OLLAMA_URL, {})).toEqual([]);
  });

  it('fills an OLLAMA_URL that is empty', () => {
    expect(envUpdates('OLLAMA_URL=\n', OLLAMA_URL, {})).toEqual([
      { key: 'OLLAMA_URL', value: OLLAMA_URL },
    ]);
  });

  it('sets only the secrets it was given', () => {
    const updates = envUpdates('OLLAMA_URL=http://x:1\nSMTP_PASSWORD=old\n', OLLAMA_URL, {});

    expect(updates).toEqual([]);
  });
});

describe('readEnvFile', () => {
  it('returns the text of the file', async () => {
    expect(await readEnvFile(harness({ envText: 'A=1\n' }).io)).toBe('A=1\n');
  });

  it('returns undefined when there is no file to read', async () => {
    const h = harness();
    h.io.readFile = () => Promise.resolve(undefined);

    expect(await readEnvFile(h.io)).toBeUndefined();
  });

  it('turns a read failure into an error that names the file and the reason, with the cause', async () => {
    const cause = Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });

    const failure = await readEnvFile(harness({ envText: 'x', envReadError: cause }).io).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DigestError);
    expect((failure as DigestError).message).toBe(`Could not read ${ENV_PATH}: EACCES: denied`);
    expect((failure as DigestError).cause).toBe(cause);
  });
});

describe('buildEnvFile with no file to merge into', () => {
  it('renders a fresh file when there is none', async () => {
    const built = await buildOn({}, { SMTP_PASSWORD: 'p' });

    expect(built).toEqual({
      text: renderEnvFile(OLLAMA_URL, { SMTP_PASSWORD: 'p' }),
      merged: false,
    });
  });

  it('renders a fresh file into an empty one, as make docker-init leaves it', async () => {
    const built = await buildOn({ empty: [ENV_PATH] });

    expect(built.merged).toBe(false);
    expect(built.text).toContain('# Written by "digest init"');
    expect(built.text).toContain('# GITHUB_TOKEN=');
  });

  it('treats a file with only blank lines as empty and writes a fresh one', async () => {
    const built = await buildOn({ envText: '\n  \n' });

    expect(built.merged).toBe(false);
    expect(built.text).toContain('# Written by "digest init"');
  });
});

describe('buildEnvFile merging into an existing file', () => {
  it('keeps every other line as it was, in its place, and adds OLLAMA_URL at the end', async () => {
    const built = await buildOn({ envText: HAND_WRITTEN });

    expect(built.merged).toBe(true);
    expect(built.text).toBe(`${HAND_WRITTEN}OLLAMA_URL=http://localhost:11434\n`);
  });

  it('keeps an OLLAMA_URL that was set by hand', async () => {
    const built = await buildOn({ envText: 'OLLAMA_URL=http://gpu-box:11434\nLOG_LEVEL=debug\n' });

    expect(built.text).toBe('OLLAMA_URL=http://gpu-box:11434\nLOG_LEVEL=debug\n');
  });

  it('fills an OLLAMA_URL that is empty', async () => {
    const built = await buildOn({ envText: 'LOG_LEVEL=debug\nOLLAMA_URL=\n' });

    expect(built.text).toBe('LOG_LEVEL=debug\nOLLAMA_URL=http://localhost:11434\n');
  });

  it('replaces the secrets it was given, wherever they stand, and keeps the rest', async () => {
    const envText = [
      'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/OLD/OLD/old',
      'GITHUB_TOKEN=ghp_keep',
      'export SMTP_PASSWORD=old-password',
      'OLLAMA_URL=http://localhost:11434',
      '',
    ].join('\n');

    const built = await buildOn(
      { envText },
      {
        SMTP_PASSWORD: 'smtp-secret',
        SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T000/B000/hook-secret',
      },
    );

    expect(built.text).toBe(
      [
        'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/hook-secret',
        'GITHUB_TOKEN=ghp_keep',
        'export SMTP_PASSWORD=smtp-secret',
        'OLLAMA_URL=http://localhost:11434',
        '',
      ].join('\n'),
    );
  });

  it('adds a secret that is not in the file yet, and quotes it like a fresh file does', async () => {
    const built = await buildOn({ envText: HAND_WRITTEN }, { SMTP_PASSWORD: 'pa ss#word' });

    expect(parseEnv(built.text)).toMatchObject({ SMTP_PASSWORD: 'pa ss#word', LOG_LEVEL: 'debug' });
    expect(built.text.startsWith(HAND_WRITTEN)).toBe(true);
  });

  it('keeps a secret it was not given this time', async () => {
    const built = await buildOn({
      envText: 'SMTP_PASSWORD=still-needed\nSLACK_WEBHOOK_URL=https://h/s/x\n',
    });

    expect(parseEnv(built.text)).toMatchObject({
      SMTP_PASSWORD: 'still-needed',
      SLACK_WEBHOOK_URL: 'https://h/s/x',
    });
  });

  it('replaces every copy of a key, so no stale duplicate wins', async () => {
    const built = await buildOn(
      { envText: 'SMTP_PASSWORD=one\nLOG_LEVEL=debug\nSMTP_PASSWORD=two\n' },
      { SMTP_PASSWORD: 'smtp-secret' },
    );

    expect(built.text).toBe(
      'SMTP_PASSWORD=smtp-secret\nLOG_LEVEL=debug\nSMTP_PASSWORD=smtp-secret\nOLLAMA_URL=http://localhost:11434\n',
    );
  });

  it('keeps Windows line endings', async () => {
    const built = await buildOn(
      { envText: 'LOG_LEVEL=debug\r\nSMTP_PASSWORD=old\r\n' },
      { SMTP_PASSWORD: 'smtp-secret' },
    );

    expect(built.text).toBe(
      'LOG_LEVEL=debug\r\nSMTP_PASSWORD=smtp-secret\r\nOLLAMA_URL=http://localhost:11434\r\n',
    );
  });

  it('starts a new line when the file does not end with one', async () => {
    const built = await buildOn({ envText: 'LOG_LEVEL=debug' });

    expect(built.text).toBe('LOG_LEVEL=debug\nOLLAMA_URL=http://localhost:11434\n');
  });

  it('leaves the loader reading every other value as before', async () => {
    const built = await buildOn({ envText: HAND_WRITTEN });

    expect(parseEnv(built.text)).toEqual({
      ...parseEnv(HAND_WRITTEN),
      OLLAMA_URL: 'http://localhost:11434',
    });
  });

  it('refuses when a line it would replace is part of another value', async () => {
    const trap = 'NOTE="first line\nSMTP_PASSWORD=inside the note"\nLOG_LEVEL=debug\n';

    await expect(buildOn({ envText: trap }, { SMTP_PASSWORD: 'p' })).rejects.toThrow(
      /Could not merge into .*\.env safely.*by hand/s,
    );
  });

  it('refuses when the file cannot be read', async () => {
    const envReadError = Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });

    await expect(buildOn({ envText: 'x=1\n', envReadError })).rejects.toThrow(
      `Could not read ${ENV_PATH}: EACCES: denied`,
    );
  });
});
