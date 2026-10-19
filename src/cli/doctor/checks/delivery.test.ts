import { describe, expect, it } from 'vitest';
import { diskIo, FEED_URL, loadedFor, runDoctor, resultFor } from '../__fixtures__/doctorHarness';
import { checkDelivery } from './delivery';

describe('checkDelivery', () => {
  const email = {
    host: 'smtp.example.com',
    user: 'digest',
    from: 'digest@example.com',
    to: ['a@example.com', 'b@example.com'],
  };

  it('checks only the markdown folder when nothing else is configured', async () => {
    const results = await checkDelivery(loadedFor(), diskIo());

    expect(results.map((r) => r.label)).toEqual(['markdown']);
  });

  it('puts the markdown folder first, then email, then Slack', async () => {
    const loaded = loadedFor({
      config: { delivery: { email, slack: { enabled: true } } },
      secrets: { SMTP_PASSWORD: 'x', SLACK_WEBHOOK_URL: 'https://hooks.example.com/x' },
    });

    const results = await checkDelivery(loaded, diskIo());

    expect(results.map((r) => r.label)).toEqual(['markdown', 'email', 'slack']);
  });

  it('counts the recipients and names the host, never the password', async () => {
    const loaded = loadedFor({
      config: { delivery: { email } },
      secrets: { SMTP_PASSWORD: 'hunter2-password' },
    });

    const results = await checkDelivery(loaded, diskIo());

    expect(results[1]?.message).toBe('SMTP_PASSWORD is set (2 recipient(s) via smtp.example.com)');
    expect(JSON.stringify(results)).not.toContain('hunter2-password');
  });

  it('fails email without SMTP_PASSWORD and Slack without SLACK_WEBHOOK_URL', async () => {
    const loaded = loadedFor({ config: { delivery: { email, slack: { enabled: true } } } });

    const results = await checkDelivery(loaded, diskIo());

    expect(results.slice(1).map((r) => [r.label, r.severity, r.fix])).toEqual([
      ['email', 'error', 'add SMTP_PASSWORD=<password> to .env'],
      ['slack', 'error', 'add SLACK_WEBHOOK_URL=<webhook url> to .env'],
    ]);
  });

  it('skips Slack when it is configured but disabled', async () => {
    const loaded = loadedFor({ config: { delivery: { slack: { enabled: false } } } });

    const results = await checkDelivery(loaded, diskIo());

    expect(results.map((r) => r.label)).toEqual(['markdown']);
  });
});

describe('doctor delivery checks', () => {
  describe('delivery', () => {
    const email = {
      host: 'smtp.example.com',
      user: 'digest',
      from: 'digest@example.com',
      to: ['me@example.com'],
    };

    it('prints ✗ when email is configured without SMTP_PASSWORD', async () => {
      const { code, text } = await runDoctor({ config: { delivery: { email } } });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'email:')).toMatch(
        /SMTP_PASSWORD.*\n\s+fix: .*SMTP_PASSWORD.*\.env/,
      );
    });

    it('prints ✓ when email is configured and SMTP_PASSWORD is present', async () => {
      const { code, text } = await runDoctor({
        config: { delivery: { email } },
        secrets: { SMTP_PASSWORD: 'hunter2-password' },
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'email:')).toBeDefined();
      expect(text).not.toContain('hunter2-password');
    });

    it('prints ✗ when Slack is enabled without SLACK_WEBHOOK_URL', async () => {
      const { code, text } = await runDoctor({
        config: { delivery: { slack: { enabled: true } } },
      });

      expect(code).toBe(1);
      expect(resultFor(text, '✗', 'slack:')).toMatch(/SLACK_WEBHOOK_URL.*\n\s+fix: .*\.env/);
    });

    it('prints ✓ when Slack is enabled and the webhook is present, without printing it', async () => {
      const webhook = 'https://hooks.slack.com/services/T000/B000/secretvalue';
      const { code, text } = await runDoctor({
        config: { delivery: { slack: { enabled: true } } },
        secrets: { SLACK_WEBHOOK_URL: webhook },
      });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', 'slack:')).toBeDefined();
      expect(text).not.toContain('secretvalue');
    });

    it('does not check Slack when it is disabled', async () => {
      const { text } = await runDoctor({ config: { delivery: { slack: { enabled: false } } } });

      expect(text).not.toContain('slack:');
    });

    it('never sends anything: only the source feeds are contacted', async () => {
      const { h } = await runDoctor({
        config: { delivery: { email, slack: { enabled: true } } },
        secrets: {
          SMTP_PASSWORD: 'hunter2-password',
          SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T000/B000/secretvalue',
        },
      });

      expect(h.fetch.mock.calls.map(([input]) => String(input))).toEqual([FEED_URL]);
    });
  });
});
