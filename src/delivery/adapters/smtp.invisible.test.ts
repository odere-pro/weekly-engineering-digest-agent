// The plain-text part of a mail shows the text as written: no invisible character in it can reorder
// or hide the text around it, with a view or without one.
import { describe, expect, it, vi } from 'vitest';
import { createSmtpDelivery, type SmtpOptions } from './smtp';

const options: SmtpOptions = {
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  user: 'digest@example.test',
  password: 'hunter2-app-password',
  from: 'Digest <digest@example.test>',
  to: ['me@example.test'],
};

function send() {
  const sendMail = vi.fn<(mail: unknown) => Promise<unknown>>(() => Promise.resolve({}));
  const delivery = createSmtpDelivery({ ...options, createTransport: () => ({ sendMail }) });
  const sent = (): { text: string; html?: string } =>
    sendMail.mock.calls[0]?.[0] as { text: string; html?: string };
  return { delivery, sent };
}

describe('a mail without a view', () => {
  it('drops invisible characters from the Markdown and keeps its lines and indentation', async () => {
    const { delivery, sent } = send();

    await delivery.sendDigest({
      weekId: '2026-W42',
      subject: 'Engineering digest 2026-W42',
      markdown:
        '# Week 2026-W42\u{202E}\n\n_Head\u{200B}line_\n\n- [Ollama\u{E0041}0.9](https://example.com/a)\n  - nested\u{FEFF}item  \n',
    });

    expect(sent().text).toBe(
      '# Week 2026-W42\n\n_Head line_\n\n- [Ollama 0.9](https://example.com/a)\n  - nested item\n',
    );
    expect(sent()).not.toHaveProperty('html');
  });

  it('keeps a joined emoji whole and sends a Markdown that has none as it is', async () => {
    const { delivery, sent } = send();
    const markdown =
      '# Digest\n\nBy \u{1F469}\u{200D}\u{1F4BB} today.\n\n| a | b |\n|---|---|\n| x | y |\n';

    await delivery.sendDigest({ weekId: '2026-W42', subject: 'Digest', markdown });

    expect(sent().text).toBe(markdown);
  });
});

describe('a failure mail', () => {
  it('drops invisible characters from the reason and keeps its lines', async () => {
    const { delivery, sent } = send();

    await delivery.sendFailure({
      weekId: '2026-W42',
      step: 'write',
      message: 'Draft said\u{202E}stop\u{200B}now\n  second line',
    });

    expect(sent().text).toBe(
      'Weekly digest 2026-W42 failed at write.\n\nDraft said stop now\n  second line\n',
    );
  });
});
