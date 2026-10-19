import { describe, expect, it } from 'vitest';
import { errnoError, resultFor, runDoctor } from '../__fixtures__/doctorHarness';
import { checkEnvFile, checkEnvValues } from './envFile';

const ENV = '/home/me/.env';
const modeOf = (mode: number) => async () => ({
  mode: 0o100000 | mode,
  isDirectory: false,
  isSymbolicLink: false,
});

describe('checkEnvFile', () => {
  it('is ok when only the owner can read the file', async () => {
    expect(await checkEnvFile({ envPath: ENV, stat: modeOf(0o600) })).toEqual({
      severity: 'ok',
      label: '.env',
      message: 'readable only by you',
    });
  });

  it('warns with the mode in octal, and the chmod fix, when group or others can read', async () => {
    const result = await checkEnvFile({ envPath: ENV, stat: modeOf(0o640) });

    expect(result).toMatchObject({
      severity: 'warn',
      message: 'readable by other users (mode 640)',
      fix: 'chmod 600 .env',
    });
  });

  it('is ok, and says the secrets come from the environment, when there is no file', async () => {
    const result = await checkEnvFile({
      envPath: ENV,
      stat: async () => {
        throw errnoError('ENOENT');
      },
    });

    expect(result.severity).toBe('ok');
    expect(result.message).toBe('no .env file (secrets come from the process environment)');
  });

  it('warns with the path and the reason when the file cannot be inspected', async () => {
    const result = await checkEnvFile({
      envPath: ENV,
      stat: async () => {
        throw errnoError('EACCES');
      },
    });

    expect(result.severity).toBe('warn');
    expect(result.message).toBe(`cannot inspect ${ENV}: EACCES: simulated`);
  });
});

describe('checkEnvValues', () => {
  it('returns one ok line for a file with no cut value', async () => {
    const results = await checkEnvValues({ envPath: ENV, readFile: async () => 'A=1\nB="x #y"\n' });

    expect(results).toEqual([
      { severity: 'ok', label: '.env values', message: 'no unquoted value contains a "#"' },
    ]);
  });

  it('returns nothing when the file does not exist: the .env check says so', async () => {
    const results = await checkEnvValues({
      envPath: ENV,
      readFile: async () => {
        throw errnoError('ENOENT');
      },
    });

    expect(results).toEqual([]);
  });

  it('warns with the key and line, and the quoting fix, never the value', async () => {
    const [result] = await checkEnvValues({
      envPath: ENV,
      readFile: async () => 'TOKEN=abc#secrettail\n',
    });

    expect(result?.severity).toBe('warn');
    expect(result?.message).toContain('TOKEN (line 1)');
    expect(result?.message).not.toContain('secrettail');
    expect(result?.fix).toBe(
      'put the value in quotes if the "#" is part of it, for example KEY="pass#word"',
    );
  });

  it('warns with the path and the reason when the file cannot be read', async () => {
    const [result] = await checkEnvValues({
      envPath: ENV,
      readFile: async () => {
        throw errnoError('EACCES');
      },
    });

    expect(result?.severity).toBe('warn');
    expect(result?.message).toBe(`cannot read ${ENV}: EACCES: simulated`);
  });
});

describe('doctor .env checks', () => {
  describe('.env permissions', () => {
    it.each([0o644, 0o640, 0o604, 0o666])(
      'prints ! with chmod 600 when .env has mode %o',
      async (mode) => {
        const { code, text } = await runDoctor({ envMode: mode });

        expect(code).toBe(0);
        expect(resultFor(text, '!', '.env:')).toMatch(
          /readable by other users.*\n\s+fix: chmod 600 \.env$/,
        );
      },
    );

    it.each([0o600, 0o400, 0o700])('prints ✓ when .env has mode %o', async (mode) => {
      const { text } = await runDoctor({ envMode: mode });

      expect(resultFor(text, '✓', '.env:')).toBeDefined();
    });

    it('prints ✓ when there is no .env file', async () => {
      const { code, text } = await runDoctor({ envMode: null });

      expect(code).toBe(0);
      expect(resultFor(text, '✓', '.env:')).toMatch(/no \.env file/i);
    });

    it('prints ! when .env cannot be inspected', async () => {
      const { code, text } = await runDoctor({ envStatError: errnoError('EACCES') });

      expect(code).toBe(0);
      expect(resultFor(text, '!', '.env:')).toContain('EACCES');
    });
  });

  describe('.env values cut at a "#"', () => {
    it('prints ✓ when no unquoted value holds a "#"', async () => {
      const envText = [
        '# written by digest init',
        'OLLAMA_URL=http://localhost:11434',
        'SMTP_PASSWORD="has # inside quotes"',
        "GITHUB_TOKEN='and # here'",
        'LOG_LEVEL=info',
        '',
      ].join('\n');

      const { text } = await runDoctor({ envText });

      expect(resultFor(text, '✓', '.env values:')).toBeDefined();
    });

    it('warns for a value with " #", naming the key and the line but never the value', async () => {
      const envText =
        'OLLAMA_URL=http://localhost:11434\nSMTP_PASSWORD=correct horse #battery staple\n';

      const { code, text } = await runDoctor({ envText });

      expect(code).toBe(0);
      expect(resultFor(text, '!', '.env values:')).toMatch(
        /SMTP_PASSWORD \(line 2\).*read as a comment.*\n\s+fix: put the value in quotes/,
      );
      expect(text).not.toMatch(/battery|correct horse/);
    });

    it('warns for a "#" without a space too, where the loader cuts the value as well', async () => {
      const { text } = await runDoctor({ envText: 'GITHUB_TOKEN=ghp_abc#def\n' });

      expect(resultFor(text, '!', '.env values:')).toContain('GITHUB_TOKEN (line 1)');
      expect(text).not.toContain('ghp_abc');
    });

    it('names every affected key once, in file order', async () => {
      const envText = ['A=one #two', 'B=fine', 'export C=three#four', 'A=again #cut', ''].join(
        '\n',
      );

      const { text } = await runDoctor({ envText });

      const line = resultFor(text, '!', '.env values:')!;
      expect(line).toContain('A (line 1)');
      expect(line).toContain('C (line 3)');
      expect(line).not.toMatch(/\bB \(line/);
      expect(line.match(/A \(line/g)).toHaveLength(1);
    });

    it('does not mistake a comment line, an empty value or a quoted value for a cut one', async () => {
      const envText = [
        '#SMTP_PASSWORD=x #y',
        '   # indented comment with KEY=a #b',
        'EMPTY=',
        'Q1="a #b"',
        "Q2='a #b'",
        'Q3=`a #b`',
        '',
      ].join('\n');

      const { text } = await runDoctor({ envText });

      expect(resultFor(text, '✓', '.env values:')).toBeDefined();
    });

    it('ignores the lines of a quoted value that spans several lines', async () => {
      const envText = 'KEY="first line\nsecond # line\nthird"\nNEXT=ok\n';

      const { text } = await runDoctor({ envText });

      expect(resultFor(text, '✓', '.env values:')).toBeDefined();
    });

    it('still reads the lines after a quote that nothing closes, as the parser does', async () => {
      const envText = 'BROKEN="never closed\nSMTP_PASSWORD=pa#ss\nOTHER=fine\n';

      const { text } = await runDoctor({ envText });

      const line = resultFor(text, '!', '.env values:')!;
      expect(line).toContain('SMTP_PASSWORD (line 2)');
      expect(line).not.toContain('BROKEN');
      expect(text).not.toContain('pa#ss');
    });

    it('follows a quote across lines to the next one of the same kind, even a stray one', async () => {
      const envText =
        'A="opens here\nB=1 #hidden in the value of A\nC=\'x\'\nD="closes A"\nE=v#w\n';

      const { text } = await runDoctor({ envText });

      const line = resultFor(text, '!', '.env values:')!;
      expect(line).toContain('E (line 5)');
      expect(line).not.toMatch(/\bB \(line/);
    });

    it('is quiet when there is no .env file', async () => {
      const { text } = await runDoctor({ envMode: null });

      expect(text).not.toContain('.env values');
    });

    it('warns when .env cannot be read, and says why', async () => {
      const { code, text } = await runDoctor({ envReadError: errnoError('EACCES') });

      expect(code).toBe(0);
      expect(resultFor(text, '!', '.env values:')).toContain('EACCES');
    });

    it('does not count toward the errors', async () => {
      const { code, text } = await runDoctor({ envText: 'A=b #c\n' });

      expect(code).toBe(0);
      expect(text).toMatch(/0 errors, 1 warning\b/);
    });
  });
});
