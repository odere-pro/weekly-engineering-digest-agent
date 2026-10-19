import { describe, expect, it } from 'vitest';
import { scriptedPrompts, validatorFor, type Rule } from '../__fixtures__/initHarness';
import { askEmail, askSlackWebhook } from './delivery';

const EMAIL_ANSWERS: readonly Rule[] = [
  [/SMTP host/, 'smtp.example.com'],
  [/SMTP user/, 'digest@example.com'],
  [/Recipients/, 'ana@example.com, bo@example.com'],
  [/SMTP password/, 'smtp-secret'],
];

async function askEmailWith(rules: readonly Rule[] = []) {
  const { prompts, calls } = scriptedPrompts([...rules, ...EMAIL_ANSWERS]);
  const answers = await askEmail(prompts);
  return { answers, calls };
}

describe('askEmail', () => {
  it('returns the delivery fields apart from the password', async () => {
    const { answers } = await askEmailWith();

    expect(answers).toEqual({
      delivery: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        requireTLS: true,
        user: 'digest@example.com',
        from: 'digest@example.com',
        to: ['ana@example.com', 'bo@example.com'],
      },
      password: 'smtp-secret',
    });
    expect(JSON.stringify(answers.delivery)).not.toContain('smtp-secret');
  });

  it('turns on implicit TLS by default for port 465 and uses the typed sender', async () => {
    const { answers, calls } = await askEmailWith([
      [/SMTP port/, '465'],
      [/From address/, 'noreply@corp.test'],
    ]);

    expect(calls.find((c) => /implicit TLS/.test(c.message))?.options.default).toBe(true);
    expect(answers.delivery).toMatchObject({ port: 465, secure: true, from: 'noreply@corp.test' });
  });

  it('leaves implicit TLS off by default for any other port', async () => {
    const { calls } = await askEmailWith();

    expect(calls.find((c) => /implicit TLS/.test(c.message))?.options.default).toBe(false);
  });

  it('takes the answer to the TLS question, not only its default', async () => {
    const { answers } = await askEmailWith([[/implicit TLS/, true]]);

    expect(answers.delivery).toMatchObject({ port: 587, secure: true, requireTLS: true });
  });

  it('offers the SMTP user as the sender when it is an email address', async () => {
    const { calls } = await askEmailWith([[/SMTP user/, ' digest@example.com ']]);

    expect(calls.find((c) => /From address/.test(c.message))?.options.default).toBe(
      'digest@example.com',
    );
  });

  it('offers no sender when the SMTP user is not an email address', async () => {
    const { prompts, calls } = scriptedPrompts([
      [/SMTP user/, 'apikey'],
      [/From address/, 'noreply@corp.test'],
      ...EMAIL_ANSWERS,
    ]);

    await askEmail(prompts);

    const from = calls.find((c) => /From address/.test(c.message));
    expect(from?.options.default).toBeUndefined();
    expect('default' in (from?.options ?? {})).toBe(false);
  });

  it('trims the host, user and sender and splits the recipients', async () => {
    const { answers } = await askEmailWith([
      [/SMTP host/, '  smtp.example.com '],
      [/From address/, ' noreply@corp.test '],
      [/Recipients/, ' ana@example.com ,, bo@example.com , '],
    ]);

    expect(answers.delivery).toMatchObject({
      host: 'smtp.example.com',
      from: 'noreply@corp.test',
      to: ['ana@example.com', 'bo@example.com'],
    });
  });

  it('keeps the password exactly as typed', async () => {
    const { answers } = await askEmailWith([[/SMTP password/, '  pa ss#word  ']]);

    expect(answers.password).toBe('  pa ss#word  ');
  });

  it('validates the answers as they are typed', async () => {
    const { calls } = await askEmailWith();
    const validator = (pattern: RegExp) => validatorFor(calls, pattern);

    expect(validator(/SMTP host/)('')).not.toBe(true);
    expect(validator(/SMTP host/)('smtp.example.com')).toBe(true);
    expect(validator(/SMTP port/)('0')).not.toBe(true);
    expect(validator(/SMTP port/)('70000')).not.toBe(true);
    expect(validator(/SMTP port/)('25.5')).not.toBe(true);
    expect(validator(/SMTP port/)('2525')).toBe(true);
    expect(validator(/SMTP user/)('')).not.toBe(true);
    expect(validator(/From address/)('nope')).not.toBe(true);
    expect(validator(/From address/)('noreply@corp.test')).toBe(true);
    expect(validator(/Recipients/)('')).not.toBe(true);
    expect(validator(/Recipients/)('ana@example.com, nope')).not.toBe(true);
    expect(validator(/Recipients/)('ana@example.com')).toBe(true);
    expect(validator(/SMTP password/)('')).not.toBe(true);
    expect(validator(/SMTP password/)('x')).toBe(true);
  });
});

describe('askSlackWebhook', () => {
  it('returns the webhook URL, trimmed', async () => {
    const { prompts } = scriptedPrompts([
      [/Slack webhook/, ' https://hooks.slack.com/services/x '],
    ]);

    expect(await askSlackWebhook(prompts)).toBe('https://hooks.slack.com/services/x');
  });

  it('asks for it as a password, so it is not echoed', async () => {
    const { prompts, calls } = scriptedPrompts([[/Slack webhook/, 'https://hooks.slack.com/x']]);

    await askSlackWebhook(prompts);

    expect(calls.map((c) => c.kind)).toEqual(['password']);
  });

  it('accepts only an https URL', async () => {
    const { prompts, calls } = scriptedPrompts([[/Slack webhook/, 'https://hooks.slack.com/x']]);
    await askSlackWebhook(prompts);
    const validate = validatorFor(calls, /Slack webhook/);

    expect(validate('not a url')).not.toBe(true);
    expect(validate('http://hooks.slack.com/x')).not.toBe(true);
    expect(validate('https://hooks.slack.com/x')).toBe(true);
  });
});
