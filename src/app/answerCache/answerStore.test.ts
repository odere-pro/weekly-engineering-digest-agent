import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { weekAnswersFile } from '../../store/layout';
import { createAnswerStore, type StoredAnswer } from './answerStore';

const WEEK = '2026-W43';
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

const DECIDED: StoredAnswer = {
  key: KEY_A,
  op: 'decide',
  model: 'clef:latest',
  answers: {
    hype: { type: 'yesno', probability: 0.07 },
    area: {
      type: 'choice',
      choice: 'Platform engineering',
      probabilities: { 'Platform engineering': 0.8, other: 0.2 },
      confidence: 0.8,
    },
    relevance: {
      type: 'score',
      level: 2.1,
      score: 0.7,
      probabilities: { none: 0.1, some: 0.2, high: 0.7 },
      confidence: 0.7,
    },
  },
};

const GENERATED: StoredAnswer = {
  key: KEY_B,
  op: 'generate',
  model: 'granite4.1-guardian:8b',
  text: '<score>no</score>',
};

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'answer-store-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function store(redact: (text: string) => string = (text) => text) {
  return createAnswerStore({ dataDir, redact });
}

async function writeRaw(text: string): Promise<void> {
  const path = weekAnswersFile(dataDir, WEEK);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

describe('createAnswerStore', () => {
  it('loads nothing for a week without a file', async () => {
    await expect(store().load(WEEK)).resolves.toEqual({ entries: new Map(), skipped: 0 });
  });

  it('gives back what was appended, by key, creating the week folder on the way', async () => {
    const answers = store();
    await answers.load(WEEK);
    await answers.append(WEEK, DECIDED);
    await answers.append(WEEK, GENERATED);

    const { entries, skipped } = await store().load(WEEK);

    expect(skipped).toBe(0);
    expect(entries).toEqual(
      new Map<string, StoredAnswer>([
        [KEY_A, DECIDED],
        [KEY_B, GENERATED],
      ]),
    );
  });

  it('writes one JSON line per answer', async () => {
    const answers = store();
    await answers.append(WEEK, DECIDED);
    await answers.append(WEEK, GENERATED);

    const lines = (await readFile(weekAnswersFile(dataDir, WEEK), 'utf8')).split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[1]!)).toEqual({
      k: KEY_B,
      op: 'generate',
      model: 'granite4.1-guardian:8b',
      text: '<score>no</score>',
    });
  });

  it('takes secrets out of a generated text before writing it', async () => {
    const answers = store((text) => text.replaceAll('hunter2', '[REDACTED]'));
    await answers.append(WEEK, { ...GENERATED, text: 'password hunter2 <score>no</score>' });

    const raw = await readFile(weekAnswersFile(dataDir, WEEK), 'utf8');
    const { entries } = await store().load(WEEK);

    expect(raw).not.toContain('hunter2');
    expect(entries.get(KEY_B)).toMatchObject({ text: 'password [REDACTED] <score>no</score>' });
  });

  it('skips and counts lines it cannot read, and keeps the rest', async () => {
    const good = JSON.stringify({ k: KEY_B, op: 'generate', model: 'm', text: 'ok' });
    await writeRaw(
      [
        'not json',
        JSON.stringify({ k: 'short', op: 'generate', model: 'm', text: 'x' }),
        JSON.stringify({ k: KEY_A, op: 'decide', model: 'm', answers: { q: { type: 'yesno' } } }),
        JSON.stringify({ k: KEY_A, op: 'guess', model: 'm' }),
        '',
        good,
        '',
      ].join('\n'),
    );

    const { entries, skipped } = await store().load(WEEK);

    expect(skipped).toBe(4);
    expect([...entries.keys()]).toEqual([KEY_B]);
  });

  it('starts a new line after a line a crash cut short, so the next answer is readable', async () => {
    const good = JSON.stringify({ k: KEY_B, op: 'generate', model: 'm', text: 'ok' });
    await writeRaw(`${good}\n{"k":"${KEY_A}","op":"dec`);
    const answers = store();

    const before = await answers.load(WEEK);
    await answers.append(WEEK, DECIDED);
    const after = await store().load(WEEK);

    expect(before).toMatchObject({ skipped: 1 });
    expect(after.skipped).toBe(1);
    expect(after.entries.get(KEY_A)).toEqual(DECIDED);
  });

  it('refuses a run id that is not an ISO week, so no path leaves the data folder', async () => {
    await expect(store().append('../2026-W43', GENERATED)).rejects.toThrow(/Invalid run id/);
  });
});
