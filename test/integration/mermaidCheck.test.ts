// `scripts/check-mermaid.mjs` parses every ```mermaid block in Markdown with the real Mermaid
// parser (no browser). It is a plain Node script run by `pnpm check` and CI, so the test runs it
// for real on Markdown files written to a temp dir.
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { useDataDir } from './harness/dataDir';

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/check-mermaid.mjs', import.meta.url));
// Importing Mermaid takes about two seconds, and every case starts a fresh process.
const SCRIPT_TIMEOUT_MS = 60_000;

const GOOD_FLOWCHART = 'flowchart LR\n  collect --> classify';
const SEQUENCE_WITH_SEMICOLON = 'sequenceDiagram\n  a->>b: one; two';
const FLOWCHART_WITH_UNQUOTED_PARENTHESES = 'flowchart TD\n  x[call (y)]';

interface ScriptResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A fenced Mermaid block, ending in a newline. */
function mermaidBlock(body: string): string {
  return `\`\`\`mermaid\n${body}\n\`\`\`\n`;
}

describe('check-mermaid script', () => {
  const dir = useDataDir();

  async function writeMarkdown(name: string, content: string): Promise<string> {
    const file = join(dir(), name);
    await writeFile(file, content, 'utf8');
    return file;
  }

  function runScript(files: readonly string[]): ScriptResult {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, ...files], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it(
    'passes a file with one good flowchart and counts the block',
    async () => {
      const file = await writeMarkdown('good.md', `# Page\n\n${mermaidBlock(GOOD_FLOWCHART)}`);

      const result = runScript([file]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Mermaid: 1 blocks in 1 files parse.');
      expect(result.stderr).toBe('');
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    'fails a sequence message with a semicolon and names the file and the fence line',
    async () => {
      const file = await writeMarkdown(
        'semicolon.md',
        `# Page\n\n${mermaidBlock(SEQUENCE_WITH_SEMICOLON)}`,
      );

      const result = runScript([file]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${file}:3: `);
      // The message is on line 2 of the diagram text, which is line 5 of the file.
      expect(result.stderr).toContain('(file line 5)');
      expect(result.stdout).toBe('');
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    'fails a flowchart label with unquoted parentheses',
    async () => {
      const file = await writeMarkdown(
        'parentheses.md',
        mermaidBlock(FLOWCHART_WITH_UNQUOTED_PARENTHESES),
      );

      const result = runScript([file]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${file}:1: `);
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    'checks a block whose fence is never closed, as it runs to the end of the file',
    async () => {
      const file = await writeMarkdown(
        'unclosed.md',
        `# Page\n\n\`\`\`mermaid\n${FLOWCHART_WITH_UNQUOTED_PARENTHESES}\n`,
      );

      const result = runScript([file]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${file}:3: `);
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    'passes a file with no Mermaid block',
    async () => {
      const file = await writeMarkdown('plain.md', '# Page\n\n```ts\nconst a = (1;\n```\n');

      const result = runScript([file]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Mermaid: 0 blocks in 0 files parse.');
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    'ignores a Mermaid block shown inside a longer fence',
    async () => {
      const shown = `\`\`\`\`md\n${mermaidBlock(SEQUENCE_WITH_SEMICOLON)}\`\`\`\`\n`;
      const file = await writeMarkdown('example.md', `${shown}\n${mermaidBlock(GOOD_FLOWCHART)}`);

      const result = runScript([file]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Mermaid: 1 blocks in 1 files parse.');
    },
    SCRIPT_TIMEOUT_MS,
  );

  it(
    'reports a bad block in each of two files',
    async () => {
      const first = await writeMarkdown('first.md', mermaidBlock(SEQUENCE_WITH_SEMICOLON));
      const second = await writeMarkdown(
        'second.md',
        `# Page\n\n${mermaidBlock(GOOD_FLOWCHART)}\n${mermaidBlock(FLOWCHART_WITH_UNQUOTED_PARENTHESES)}`,
      );

      const result = runScript([first, second]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${first}:1: `);
      // The second block of the second file opens on line 8.
      expect(result.stderr).toContain(`${second}:8: `);
      expect(result.stderr).toContain('Mermaid: 2 of 3 blocks do not parse.');
    },
    SCRIPT_TIMEOUT_MS,
  );
});
