import { describe, expect, it } from 'vitest';
import { knownSecrets } from './knownSecrets';

const SMTP_PASSWORD = 'smtp-password-4f9a';
const WEBHOOK_PATH = '/services/T000/B000/slack-secret-7c1e';
const SLACK_WEBHOOK_URL = `https://hooks.slack.test${WEBHOOK_PATH}`;
const GITHUB_TOKEN = 'ghp_github-token-82bd';

describe('knownSecrets', () => {
  it('lists every secret value that is set', () => {
    const secrets = knownSecrets({ SMTP_PASSWORD, GITHUB_TOKEN });

    expect(secrets).toEqual([SMTP_PASSWORD, GITHUB_TOKEN]);
  });

  it('leaves out secrets that are empty or missing', () => {
    expect(knownSecrets({ SMTP_PASSWORD: '', GITHUB_TOKEN: undefined })).toEqual([]);
    expect(knownSecrets({})).toEqual([]);
  });

  it('adds the path of the Slack webhook, which is the secret part of the URL', () => {
    const secrets = knownSecrets({ SLACK_WEBHOOK_URL });

    expect(secrets).toEqual([SLACK_WEBHOOK_URL, WEBHOOK_PATH]);
  });

  it('copes with a webhook that is not a URL, and with one that has no path', () => {
    expect(knownSecrets({ SLACK_WEBHOOK_URL: 'not a url' })).toEqual(['not a url']);
    expect(knownSecrets({ SLACK_WEBHOOK_URL: 'https://hooks.slack.test' })).toEqual([
      'https://hooks.slack.test',
    ]);
  });

  it('adds nothing for a webhook that is empty', () => {
    expect(knownSecrets({ SLACK_WEBHOOK_URL: '' })).toEqual([]);
  });

  it('does not change the secrets it was given', () => {
    const secrets = { SMTP_PASSWORD, SLACK_WEBHOOK_URL };

    knownSecrets(secrets);

    expect(secrets).toEqual({ SMTP_PASSWORD, SLACK_WEBHOOK_URL });
  });
});
