import { describe, expect, it } from 'vitest';
import { withoutUrlCredentials } from './withoutUrlCredentials';

describe('withoutUrlCredentials', () => {
  it('removes user and password from an https URL', () => {
    expect(withoutUrlCredentials('see https://user:s3cret@host.example:11434/path')).toBe(
      'see https://host.example:11434/path',
    );
  });

  it('removes a lone token used as the user name', () => {
    expect(withoutUrlCredentials('http://tok3n@gpu:11434')).toBe('http://gpu:11434');
  });

  it('removes the credentials of every URL in the text', () => {
    const text = 'a http://u:p@one:1 and b https://v:q@two:2/x';

    expect(withoutUrlCredentials(text)).toBe('a http://one:1 and b https://two:2/x');
  });

  it('keeps a password that holds a colon or a hash out of the result', () => {
    const cleaned = withoutUrlCredentials('https://me:pa:ss#word@host/feed');

    expect(cleaned).toBe('https://host/feed');
    expect(cleaned).not.toContain('pa:ss');
  });

  it('leaves a URL without credentials as it is', () => {
    const text = 'Ollama at http://localhost:11434 failed';

    expect(withoutUrlCredentials(text)).toBe(text);
  });

  it('leaves an email address and an @ later in the path alone', () => {
    const text = 'write to me@example.com or open https://host.example/@handle';

    expect(withoutUrlCredentials(text)).toBe(text);
  });

  it('returns an empty string unchanged', () => {
    expect(withoutUrlCredentials('')).toBe('');
  });
});
