// `scripts/check-mermaid.mjs` parses every ```mermaid block in Markdown with the real Mermaid
// parser (no browser). It is a plain Node script run by `pnpm check` and CI, so the test runs it
// for real on Markdown files written to a temp dir.
// Importing Mermaid takes about a second, so each `describe` runs the script once and its cases
// read different parts of that one result.
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/check-mermaid.mjs', import.meta.url));
const NODE_MODULES_PATH = fileURLToPath(new URL('../../node_modules', import.meta.url));
// Importing Mermaid takes a second or two, longer when the machine is busy.
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

/** One temp folder for a whole `describe`, removed afterwards. Read its path inside a hook or case. */
function useSharedDir(): () => string {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'digest-mermaid-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return () => dir;
}

async function writeMarkdown(root: string, name: string, content: string): Promise<string> {
  const file = join(root, name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return file;
}

function runNode(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): ScriptResult {
  const result = spawnSync(process.execPath, [...args], { cwd, encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('check-mermaid script on the files it is given', () => {
  const dir = useSharedDir();

  function runScript(files: readonly string[]): ScriptResult {
    return runNode([SCRIPT_PATH, ...files], dir(), process.env);
  }

  describe('when every block parses', () => {
    let result: ScriptResult;

    beforeAll(async () => {
      const good = await writeMarkdown(
        dir(),
        'good.md',
        `# Page\n\n${mermaidBlock(GOOD_FLOWCHART)}`,
      );
      // A fence that is not Mermaid is never parsed, even when its code would not parse.
      const plain = await writeMarkdown(dir(), 'plain.md', '# Page\n\n```ts\nconst a = (1;\n```\n');
      // A Mermaid block shown inside a longer fence is an example, not a diagram.
      const shown = `\`\`\`\`md\n${mermaidBlock(SEQUENCE_WITH_SEMICOLON)}\`\`\`\`\n`;
      const example = await writeMarkdown(
        dir(),
        'example.md',
        `${shown}\n${mermaidBlock(GOOD_FLOWCHART)}`,
      );

      result = runScript([good, plain, example]);
    }, SCRIPT_TIMEOUT_MS);

    it('exits 0 and prints nothing on stderr', () => {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('counts the good flowcharts, and ignores a file with no Mermaid block and a shown example', () => {
      // good.md and example.md hold one real block each; plain.md holds none and adds no file.
      expect(result.stdout).toContain('Mermaid: 2 blocks in 2 files parse.');
    });
  });

  describe('when blocks do not parse', () => {
    let result: ScriptResult;
    let semicolon: string;
    let parentheses: string;
    let unclosed: string;
    let second: string;

    beforeAll(async () => {
      semicolon = await writeMarkdown(
        dir(),
        'semicolon.md',
        `# Page\n\n${mermaidBlock(SEQUENCE_WITH_SEMICOLON)}`,
      );
      parentheses = await writeMarkdown(
        dir(),
        'parentheses.md',
        mermaidBlock(FLOWCHART_WITH_UNQUOTED_PARENTHESES),
      );
      unclosed = await writeMarkdown(
        dir(),
        'unclosed.md',
        `# Page\n\n\`\`\`mermaid\n${FLOWCHART_WITH_UNQUOTED_PARENTHESES}\n`,
      );
      second = await writeMarkdown(
        dir(),
        'second.md',
        `# Page\n\n${mermaidBlock(GOOD_FLOWCHART)}\n${mermaidBlock(FLOWCHART_WITH_UNQUOTED_PARENTHESES)}`,
      );

      result = runScript([semicolon, parentheses, unclosed, second]);
    }, SCRIPT_TIMEOUT_MS);

    it('exits 1 and prints no success line', () => {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
    });

    it('fails a sequence message with a semicolon and names the file and the fence line', () => {
      expect(result.stderr).toContain(`${semicolon}:3: `);
      // The message is on line 2 of the diagram text, which is line 5 of the file.
      expect(result.stderr).toContain('(file line 5)');
    });

    it('fails a flowchart label with unquoted parentheses', () => {
      expect(result.stderr).toContain(`${parentheses}:1: `);
    });

    it('checks a block whose fence is never closed, as it runs to the end of the file', () => {
      expect(result.stderr).toContain(`${unclosed}:3: `);
    });

    it('reports the bad block of a file that also has a good one, and counts every bad block', () => {
      // The good block opens on line 3, the bad one on line 8.
      expect(result.stderr).toContain(`${second}:8: `);
      expect(result.stderr).not.toContain(`${second}:3: `);
      expect(result.stderr).toContain('Mermaid: 4 of 5 blocks do not parse.');
    });
  });
});

// With no file arguments the script asks git for the Markdown files. It finds the repo from its own
// location, so this runs a copy of it inside a throwaway repo, with `node_modules` linked in.
describe('check-mermaid script without file arguments', () => {
  const dir = useSharedDir();
  let result: ScriptResult;

  // Git must act on the throwaway repo even when the test itself runs inside a hook or a rebase.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );

  function git(args: readonly string[]): void {
    const run = spawnSync('git', [...args], { cwd: dir(), encoding: 'utf8', env });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  }

  beforeAll(async () => {
    const root = dir();
    git(['init', '--quiet']);
    await mkdir(join(root, 'scripts'));
    await copyFile(SCRIPT_PATH, join(root, 'scripts', 'check-mermaid.mjs'));
    await symlink(NODE_MODULES_PATH, join(root, 'node_modules'), 'dir');
    await writeMarkdown(root, '.gitignore', 'ignored/\n');
    await writeMarkdown(root, 'docs/staged.md', mermaidBlock(FLOWCHART_WITH_UNQUOTED_PARENTHESES));
    git(['add', 'docs/staged.md']);
    await writeMarkdown(root, 'docs/new.md', mermaidBlock(SEQUENCE_WITH_SEMICOLON));
    await writeMarkdown(root, 'docs/new-good.md', mermaidBlock(GOOD_FLOWCHART));
    await writeMarkdown(root, 'ignored/bad.md', mermaidBlock(SEQUENCE_WITH_SEMICOLON));

    result = runNode([join(root, 'scripts', 'check-mermaid.mjs')], root, env);
  }, SCRIPT_TIMEOUT_MS);

  it('checks a file that git tracks', () => {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('docs/staged.md:1: ');
  });

  it('checks a new Markdown file that git does not track yet', () => {
    expect(result.stderr).toContain('docs/new.md:1: ');
  });

  it('skips a file that .gitignore excludes', () => {
    expect(result.stderr).not.toContain('ignored/bad.md');
  });

  it('counts the staged file and the two new ones, and not the ignored one', () => {
    expect(result.stderr).toContain('Mermaid: 2 of 3 blocks do not parse.');
  });
});
