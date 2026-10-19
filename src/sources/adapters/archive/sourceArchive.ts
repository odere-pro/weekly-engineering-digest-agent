import { mkdir, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Item } from '../../../domain/schemas';
import { writeFileAtomic } from '../../../shared/atomicFile';
import { sourceDir } from '../../../store/layout';
import type { Answer } from '../http';

// Keeps what a source answered (raw/) and the items it was read into (formatted/), per day, in
// the dist/ layout (`store/layout.ts`). Runs and `digest fetch` both write through it.

/** What one fetch of one source produced. */
export interface SourceRecording {
  /** The source's own answers, in order (not the article pages fetched to fill in text). */
  answers: readonly Answer[];
  /** The items the fetch returned; absent when it failed. */
  items?: readonly Item[];
}

/** The files a save wrote, relative to the day folder, with `/` on every system (they go into JSON). */
export interface SavedSource {
  raw: string[];
  /** Absent when the recording had no items (a failed fetch). */
  formatted?: string;
}

export interface SourceArchive {
  /** Replaces the source's folders of `day` (YYYY-MM-DD) with this recording. */
  save(day: string, sourceId: string, recording: SourceRecording): Promise<SavedSource>;
}

export interface SourceArchiveOptions {
  /** The data folder. */
  dataDir: string;
  /** Applied to every text written (bodies, URLs, items): takes the secrets out. */
  redact?: (text: string) => string;
}

const RAW_PREFIX = 'response-';
const INDEX_FILE = 'responses.json';
const ITEMS_FILE = 'items.json';
const JSON_START = /^[[{]/;
const HTML_START = /^<(?:!doctype\s+html|html|head|body)\b/i;
const SNIFF_CHARS = 32;

export function createSourceArchive(options: SourceArchiveOptions): SourceArchive {
  const redact = options.redact ?? ((text: string): string => text);
  return {
    async save(day, sourceId, recording) {
      const rawDir = sourceDir(options.dataDir, day, sourceId, 'raw');
      const formattedDir = sourceDir(options.dataDir, day, sourceId, 'formatted');
      await Promise.all(
        [rawDir, formattedDir].map((dir) => rm(dir, { recursive: true, force: true })),
      );

      const raw = await saveAnswers(rawDir, recording.answers, redact);
      const relative = (dir: string, file: string): string => posix.join(sourceId, dir, file);
      if (recording.items === undefined) return { raw: raw.map((file) => relative('raw', file)) };

      await mkdir(formattedDir, { recursive: true });
      await writeFileAtomic(join(formattedDir, ITEMS_FILE), redact(toJson(recording.items)));
      return {
        raw: raw.map((file) => relative('raw', file)),
        formatted: relative('formatted', ITEMS_FILE),
      };
    },
  };
}

/** Writes the bodies as response-<n>.<ext> and an index of every answer; returns the body files. */
async function saveAnswers(
  dir: string,
  answers: readonly Answer[],
  redact: (text: string) => string,
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const index = answers.map((answer, i) => ({
    file: answer.body === '' ? null : `${RAW_PREFIX}${i + 1}.${rawExtension(answer)}`,
    url: withoutQuery(answer.url),
    status: answer.status,
    contentType: answer.contentType ?? null,
  }));
  const files: string[] = [];
  for (const [i, entry] of index.entries()) {
    if (entry.file === null) continue;
    await writeFileAtomic(join(dir, entry.file), redact(answers[i]?.body ?? ''));
    files.push(entry.file);
  }
  await writeFileAtomic(join(dir, INDEX_FILE), redact(toJson(index)));
  return files;
}

/** From the content type the server sent; else from the first characters of the body. */
export function rawExtension({
  contentType,
  body,
}: Pick<Answer, 'contentType' | 'body'>): 'xml' | 'json' | 'html' {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('json')) return 'json';
  if (type.includes('html')) return 'html';
  if (/xml|atom|rss/.test(type)) return 'xml';
  const start = body.trimStart().slice(0, SNIFF_CHARS);
  if (JSON_START.test(start)) return 'json';
  if (HTML_START.test(start)) return 'html';
  return start.startsWith('<') ? 'xml' : 'html';
}

/** Origin and path only: a source URL may carry a secret in its query (`sources/CLAUDE.md`). */
function withoutQuery(url: string): string {
  if (!URL.canParse(url)) return '';
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname}`;
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
