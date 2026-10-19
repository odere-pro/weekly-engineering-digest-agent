// The commit-msg hook (`.githooks/commit-msg`) rejects AI attribution and a subject over 72
// characters. It is a bash script, so the test runs it for real on message files in a temp dir.
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { useDataDir } from './harness/dataDir';

const HOOK_PATH = fileURLToPath(new URL('../../.githooks/commit-msg', import.meta.url));
const SUBJECT_LIMIT = 72;

interface HookResult {
  readonly status: number | null;
  readonly stderr: string;
}

describe('commit-msg hook', () => {
  const dir = useDataDir();

  async function runHook(message: string, env: NodeJS.ProcessEnv = {}): Promise<HookResult> {
    const messageFile = join(dir(), 'COMMIT_EDITMSG');
    await writeFile(messageFile, message, 'utf8');
    const result = spawnSync('bash', [HOOK_PATH, messageFile], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { status: result.status, stderr: result.stderr };
  }

  describe('subject length', () => {
    it('accepts a subject of exactly 72 ASCII characters', async () => {
      const result = await runHook(`${'a'.repeat(SUBJECT_LIMIT)}\n`);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('rejects a subject of 73 characters and says how long it is', async () => {
      const result = await runHook(`${'a'.repeat(SUBJECT_LIMIT + 1)}\n`);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('commit-msg: subject is 73 characters; the limit is 72.');
    });

    it('accepts a message without a trailing newline', async () => {
      const result = await runHook('a'.repeat(SUBJECT_LIMIT));

      expect(result.status).toBe(0);
    });

    it('rejects an over-long subject in a message without a trailing newline', async () => {
      const result = await runHook('a'.repeat(SUBJECT_LIMIT + 1));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('subject is 73 characters');
    });

    it('does not count a Windows line ending', async () => {
      const result = await runHook(`${'a'.repeat(SUBJECT_LIMIT)}\r\n\r\nbody\r\n`);

      expect(result.status).toBe(0);
    });

    it('does not count trailing spaces, which git strips from the subject', async () => {
      const result = await runHook(`${'a'.repeat(SUBJECT_LIMIT)}   \n`);

      expect(result.status).toBe(0);
    });

    it('accepts an empty message, which git rejects on its own', async () => {
      const result = await runHook('\n# only a comment\n');

      expect(result.status).toBe(0);
    });
  });

  describe('multibyte subjects', () => {
    // 72 characters that take 2 to 4 bytes each: bytes would be well over 72.
    const multibyteSubject = `feat: ${'é'.repeat(30)} — ${'\u{1F680}'.repeat(5)}${'x'.repeat(28)}`;

    it('counts characters, not bytes', async () => {
      expect(Array.from(multibyteSubject)).toHaveLength(SUBJECT_LIMIT);
      expect(Buffer.byteLength(multibyteSubject)).toBeGreaterThan(SUBJECT_LIMIT);

      const result = await runHook(`${multibyteSubject}\n`);

      expect(result.status).toBe(0);
    });

    it('rejects 73 characters and reports 73, not the byte count', async () => {
      const result = await runHook(`${multibyteSubject}x\n`);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('subject is 73 characters; the limit is 72.');
    });

    it.each(['C', 'POSIX', 'en_US.UTF-8', 'de_DE.ISO8859-1'])(
      'counts the same whatever the caller locale is (LC_ALL=%s)',
      async (locale) => {
        const env = { LC_ALL: locale, LANG: locale, LC_CTYPE: locale };

        const accepted = await runHook(`${multibyteSubject}\n`, env);
        const rejected = await runHook(`${multibyteSubject}x\n`, env);

        expect(accepted.status).toBe(0);
        expect(rejected.status).toBe(1);
        expect(rejected.stderr).toContain('subject is 73 characters');
      },
    );
  });

  describe('which line is the subject', () => {
    it('skips leading comment and blank lines', async () => {
      const message = `\n# Please enter the commit message\n   \n# more help\n${'a'.repeat(SUBJECT_LIMIT)}\n`;

      const result = await runHook(message);

      expect(result.status).toBe(0);
    });

    it('measures the first real line, not the comment above it', async () => {
      const message = `# ${'c'.repeat(100)}\n\n${'a'.repeat(SUBJECT_LIMIT + 1)}\n`;

      const result = await runHook(message);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('subject is 73 characters');
    });

    it('allows a body line longer than 72 characters', async () => {
      const message = `feat: short subject\n\n${'b'.repeat(200)}\n`;

      const result = await runHook(message);

      expect(result.status).toBe(0);
    });

    it('allows a long comment line after a short subject', async () => {
      const message = `feat: short subject\n\n# ${'c'.repeat(200)}\n`;

      const result = await runHook(message);

      expect(result.status).toBe(0);
    });
  });

  describe('subjects git writes itself', () => {
    const LONG_TAIL = 'x'.repeat(90 - 'Merge '.length);

    it.each([
      ['a merge', `Merge ${LONG_TAIL}`],
      ['a revert', `Revert "${'x'.repeat(90 - 'Revert "'.length - 1)}"`],
      ['a fixup', `fixup! ${'x'.repeat(90 - 'fixup! '.length)}`],
      ['a squash', `squash! ${'x'.repeat(90 - 'squash! '.length)}`],
      ['an amend', `amend! ${'x'.repeat(90 - 'amend! '.length)}`],
    ])('passes %s at 90 characters', async (_name, subject) => {
      expect(subject).toHaveLength(90);

      const result = await runHook(`${subject}\n`);

      expect(result.status).toBe(0);
    });

    it('does not exempt a subject that only resembles one', async () => {
      const result = await runHook(`Merged ${'x'.repeat(90)}\n`);

      expect(result.status).toBe(1);
    });
  });

  describe('AI attribution', () => {
    it.each([
      ['a Claude Co-Authored-By trailer', 'Co-Authored-By: Claude <noreply@anthropic.com>'],
      ['an Anthropic Co-Authored-By trailer', 'co-authored-by: Anthropic <ai@example.com>'],
      ['the Anthropic no-reply address', 'Signed off by noreply@anthropic.com'],
      ['a generated-with line', 'Generated with Claude Code'],
    ])('still rejects %s', async (_name, line) => {
      const result = await runHook(`feat: short subject\n\n${line}\n`);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('commit-msg: AI attribution');
    });

    it('accepts a short, clean message', async () => {
      const result = await runHook('feat: add a thing\n\nWhy it matters.\n');

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });
  });
});
