import { describe, expect, it } from 'vitest';
import { DATA_DIR, resultFor, runDoctor } from '../__fixtures__/doctorHarness';
import { fail, ok, warn } from './checkResult';
import { formatResult, report, summary } from './report';

function capture(): { stdout: (text: string) => void; text: () => string } {
  const chunks: string[] = [];
  return {
    stdout: (text) => {
      chunks.push(text);
    },
    text: () => chunks.join(''),
  };
}

describe('formatResult', () => {
  it('starts a line with the symbol of the severity, the label and the message', () => {
    expect(formatResult(ok('guards', 'all guards on'))).toBe('✓ guards: all guards on');
    expect(formatResult(warn('.env', 'loose', 'chmod 600 .env'))).toMatch(/^! \.env: loose\n/);
    expect(formatResult(fail('config', 'bad', 'fix it'))).toMatch(/^✗ config: bad\n/);
  });

  it('adds the fix line to a warning and an error', () => {
    expect(formatResult(warn('.env', 'loose', 'chmod 600 .env'))).toBe(
      '! .env: loose\n    fix: chmod 600 .env',
    );
    expect(formatResult(fail('config', 'bad', 'fix it'))).toBe('✗ config: bad\n    fix: fix it');
  });

  it('leaves out the fix of an ok result', () => {
    const result = { ...ok('guards', 'all guards on'), fix: 'ignored' };

    expect(formatResult(result)).toBe('✓ guards: all guards on');
  });

  it('indents the later lines of a multi-line message', () => {
    expect(formatResult(fail('config', 'first\nsecond\nthird', 'fix it'))).toBe(
      '✗ config: first\n    second\n    third\n    fix: fix it',
    );
  });
});

describe('summary', () => {
  it('says all checks passed when there is nothing to report', () => {
    expect(summary(0, 0)).toBe('Doctor: all checks passed.');
  });

  it('counts errors and warnings, singular and plural', () => {
    expect(summary(1, 1)).toBe('Doctor: 1 error, 1 warning.');
    expect(summary(2, 0)).toBe('Doctor: 2 errors, 0 warnings.');
    expect(summary(0, 3)).toBe('Doctor: 0 errors, 3 warnings.');
  });
});

describe('report', () => {
  it('prints each result, a blank line and the summary, and returns 0 without errors', () => {
    const out = capture();

    const code = report([ok('a', 'fine'), warn('b', 'hm', 'do x')], out.stdout, []);

    expect(code).toBe(0);
    expect(out.text()).toBe('✓ a: fine\n! b: hm\n    fix: do x\n\nDoctor: 0 errors, 1 warning.\n');
  });

  it('returns 1 when any result is an error', () => {
    const out = capture();

    const code = report([ok('a', 'fine'), fail('b', 'broken', 'do x')], out.stdout, []);

    expect(code).toBe(1);
    expect(out.text()).toContain('Doctor: 1 error, 0 warnings.');
  });

  it('removes a secret value from every line, the fix lines too', () => {
    const out = capture();

    report(
      [warn('source', 'failed with ghp_supersecrettoken', 'rotate ghp_supersecrettoken')],
      out.stdout,
      ['ghp_supersecrettoken'],
    );

    expect(out.text()).not.toContain('ghp_supersecrettoken');
    expect(out.text()).toContain('[redacted]');
  });

  it('removes credentials from a URL in the text', () => {
    const out = capture();

    report(
      [fail('ollama', 'no answer from http://user:tok3n@gpu:11434', 'start it')],
      out.stdout,
      [],
    );

    expect(out.text()).toContain('http://gpu:11434');
    expect(out.text()).not.toContain('tok3n');
  });
});

describe('doctor report through doctorCommand', () => {
  describe('exit code and summary', () => {
    it('returns 0 and counts warnings when there are only warnings', async () => {
      const { code, text } = await runDoctor({
        envMode: 0o644,
        config: { guards: { input: { enabled: false } } },
      });

      expect(code).toBe(0);
      expect(text).toMatch(/0 errors, 2 warnings/);
    });

    it('returns 1 and counts errors when any check fails', async () => {
      const { code, text } = await runDoctor({
        readOnlyDirs: [DATA_DIR],
        envMode: 0o644,
      });

      expect(code).toBe(1);
      expect(text).toMatch(/1 error, 1 warning\b/);
    });
  });

  it('never prints the source URL, its query or credentials embedded in another URL', async () => {
    const privateUrl = 'https://feeds.example.com/f.xml?token=abc123';
    const { text } = await runDoctor({
      config: { sources: [{ id: 'priv', kind: 'rss', url: privateUrl }] },
      fetch: async () => new Response('no', { status: 401 }),
      health: { error: `Ollama at http://u:pw@localhost:11434 failed`, models: [] },
    });

    expect(text).not.toMatch(/abc123|feeds\.example\.com|u:pw@/);
    expect(resultFor(text, '!', 'source priv:')).toContain('401');
    expect(text).toContain('http://localhost:11434 failed');
  });

  it('never prints a secret that appears in a source error', async () => {
    const { text } = await runDoctor({
      secrets: { GITHUB_TOKEN: 'ghp_supersecrettoken' },
      fetch: async () => {
        throw new Error('request failed with token ghp_supersecrettoken');
      },
    });

    expect(text).not.toContain('ghp_supersecrettoken');
    expect(resultFor(text, '!', 'source example-feed:')).toContain('[redacted]');
  });

  it('never prints the password of OLLAMA_URL, as written or decoded, nor its user', async () => {
    const ollamaUrl = 'http://ollama-user:pa%40ss-ollama-9d2@ollama.test:11434';
    const { text } = await runDoctor({
      ollamaUrl,
      health: {
        reachable: false,
        models: [],
        error: `refused ${ollamaUrl}; echoed pa@ss-ollama-9d2`,
      },
    });

    expect(text).not.toMatch(/pa@ss-ollama-9d2|pa%40ss-ollama-9d2|ollama-user/);
    expect(resultFor(text, '✗', 'ollama:')).toContain(
      'refused http://ollama.test:11434; echoed [redacted]',
    );
  });
});
