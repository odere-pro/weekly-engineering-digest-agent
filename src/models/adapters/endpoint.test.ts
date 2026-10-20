import { describe, expect, it } from 'vitest';
import { hasHttpScheme, parseEndpoint, urlCredentialSecrets } from './endpoint';

const basic = (userAndPassword: string): string =>
  `Basic ${Buffer.from(userAndPassword).toString('base64')}`;

describe('parseEndpoint', () => {
  it('keeps a plain URL as it is, minus trailing slashes, and sends no authorization', () => {
    expect(parseEndpoint('http://127.0.0.1:11434/')).toEqual({
      root: 'http://127.0.0.1:11434',
      authorization: undefined,
    });
  });

  it('strips trailing slashes after a very long run of slashes in bounded time', () => {
    const hostile = `http://proxy.test/${'/'.repeat(100_000)}x//`;
    const started = Date.now();
    expect(parseEndpoint(hostile).root).toBe(`http://proxy.test/${'/'.repeat(100_000)}x`);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('keeps a path prefix, as a reverse proxy needs it', () => {
    expect(parseEndpoint('https://proxy.example.test/ollama//').root).toBe(
      'https://proxy.example.test/ollama',
    );
  });

  it('moves a user and password out of the URL into a Basic authorization header', () => {
    const endpoint = parseEndpoint('http://user:S3cretPw@host.test:11434');

    expect(endpoint.root).toBe('http://host.test:11434');
    expect(endpoint.authorization).toBe(basic('user:S3cretPw'));
  });

  it('decodes percent-encoded credentials before it encodes them for the header', () => {
    const endpoint = parseEndpoint('https://me%40corp:p%40ss%3Aword%2F1@host.test/api-prefix/');

    expect(endpoint.root).toBe('https://host.test/api-prefix');
    expect(endpoint.authorization).toBe(basic('me@corp:p@ss:word/1'));
  });

  it('reads the password after the first colon, and splits at the last @ of the authority', () => {
    const endpoint = parseEndpoint('http://user:pa:ss@word@host.test:11434/x');

    expect(endpoint.root).toBe('http://host.test:11434/x');
    expect(endpoint.authorization).toBe(basic('user:pa:ss@word'));
  });

  it('treats a lone user as a user with an empty password', () => {
    const endpoint = parseEndpoint('http://token-abc@host.test');

    expect(endpoint.root).toBe('http://host.test');
    expect(endpoint.authorization).toBe(basic('token-abc:'));
  });

  it('keeps a bad percent sequence as it was written', () => {
    expect(parseEndpoint('http://user:100%@host.test').authorization).toBe(basic('user:100%'));
  });

  it('ignores an empty userinfo', () => {
    expect(parseEndpoint('http://@host.test')).toEqual({
      root: 'http://host.test',
      authorization: undefined,
    });
  });

  it('does not take an @ in the path for credentials', () => {
    expect(parseEndpoint('http://host.test/a@b')).toEqual({
      root: 'http://host.test/a@b',
      authorization: undefined,
    });
  });

  it('leaves no credentials in the root of a URL that has no scheme or is not a URL at all', () => {
    expect(parseEndpoint('user:pw@localhost:11434').root).toBe('localhost:11434');
    expect(parseEndpoint('http://user:pw@host:99999').root).toBe('http://host:99999');
    expect(parseEndpoint('  http://user:pw@host.test  ').root).toBe('http://host.test');
  });
});

describe('hasHttpScheme', () => {
  it.each(['http://localhost:11434', 'https://ollama.test', 'HTTP://LOCALHOST'])(
    'accepts %s',
    (url) => {
      expect(hasHttpScheme(url)).toBe(true);
    },
  );

  it.each(['localhost:11434', '127.0.0.1:11434', '//host', 'ftp://host', ''])(
    'rejects %j',
    (url) => {
      expect(hasHttpScheme(url)).toBe(false);
    },
  );
});

describe('urlCredentialSecrets', () => {
  it('lists the password as written and decoded', () => {
    expect(urlCredentialSecrets('http://user:p%40ss%2Fword@host.test')).toEqual([
      'p%40ss%2Fword',
      'p@ss/word',
    ]);
  });

  it('lists a password once when decoding changes nothing', () => {
    expect(urlCredentialSecrets('http://user:S3cretPw@host.test')).toEqual(['S3cretPw']);
  });

  it('lists the user when there is no password, because a lone user is the token', () => {
    expect(urlCredentialSecrets('http://token-abc@host.test')).toEqual(['token-abc']);
  });

  it('lists nothing for a URL without credentials', () => {
    expect(urlCredentialSecrets('http://localhost:11434')).toEqual([]);
    expect(urlCredentialSecrets('http://:@localhost:11434')).toEqual([]);
  });
});
