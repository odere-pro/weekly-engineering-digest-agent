// Parses every ```mermaid block in Markdown with the real Mermaid parser, so a diagram that
// would not render fails `pnpm check` and CI instead of showing an error on the page.
// No browser: a jsdom window supplies the few DOM globals that Mermaid (DOMPurify, d3) looks for.
//
// usage: node scripts/check-mermaid.mjs [file.md ...]   (no files: every tracked *.md file)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_DETAIL_WIDTH = 140;

/**
 * Makes a jsdom window visible as globals. Call it before Mermaid is imported. These two are
 * enough for the parser; if a Mermaid upgrade asks for another global, add it here.
 */
async function installDom() {
  const { JSDOM } = await import('jsdom');
  const { window } = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
}

/** The files to check as `{ label, path }`: the label is what a failure prints. */
function filesToCheck(args) {
  if (args.length > 0) return args.map((arg) => ({ label: arg, path: arg }));
  const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '*.md'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return tracked
    .split('\0')
    .filter((name) => name !== '')
    .map((name) => ({ label: name, path: join(REPO_ROOT, name) }));
}

/** The fenced blocks tagged `mermaid`: `{ label, line, text }`, line = the opening fence's line. */
function extractBlocks({ label, path }) {
  const blocks = [];
  let open = null; // { char, length, isMermaid, line, body } while inside a fence
  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .forEach((lineText, index) => {
      const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lineText);
      if (open === null) {
        if (fence) {
          const [, marker, info] = fence;
          open = {
            char: marker[0],
            length: marker.length,
            isMermaid: info.toLowerCase() === 'mermaid',
            line: index + 1,
            body: [],
          };
        }
        return;
      }
      // A closing fence uses the same character, is at least as long and has no info string.
      const closes =
        fence && fence[1][0] === open.char && fence[1].length >= open.length && !fence[2];
      if (!closes) {
        open.body.push(lineText);
        return;
      }
      if (open.isMermaid) blocks.push({ label, line: open.line, text: open.body.join('\n') });
      open = null;
    });
  // An unclosed fence runs to the end of the file (CommonMark), so its block is still checked.
  if (open?.isMermaid) blocks.push({ label, line: open.line, text: open.body.join('\n') });
  return blocks;
}

const clip = (text) =>
  text.length > MAX_DETAIL_WIDTH ? `${text.slice(0, MAX_DETAIL_WIDTH)}...` : text;

/** Prints one failure: `path:line: first line of the error`, then its context, indented. */
function reportFailure(block, error) {
  const [first, ...context] = String(error?.message ?? error)
    .trimEnd()
    .split('\n');
  // "Parse error on line N" counts from the first line after the opening fence.
  const parserLine = /on line (\d+)/.exec(first);
  const where = parserLine ? ` (file line ${block.line + Number(parserLine[1])})` : '';
  console.error(`${block.label}:${block.line}: ${first.replace(/:$/, '')}${where}`);
  for (const detail of context) console.error(`    ${clip(detail)}`);
}

await installDom();
const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false, logLevel: 'fatal' });

const files = filesToCheck(process.argv.slice(2));
const blocks = files.flatMap(extractBlocks);
const filesWithBlocks = new Set(blocks.map((block) => block.label));

let failed = 0;
for (const block of blocks) {
  try {
    await mermaid.parse(block.text, { suppressErrors: false });
  } catch (error) {
    failed += 1;
    reportFailure(block, error);
  }
}

if (failed > 0) {
  console.error(`Mermaid: ${failed} of ${blocks.length} blocks do not parse.`);
  process.exitCode = 1;
} else {
  console.log(`Mermaid: ${blocks.length} blocks in ${filesWithBlocks.size} files parse.`);
}
