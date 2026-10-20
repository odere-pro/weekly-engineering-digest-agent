import { describe, expect, it } from 'vitest';
import type { Source } from '../../../domain/schemas';
import { DigestError } from '../../../shared/errors';
import { scriptedPrompts } from '../../init/__fixtures__/initHarness';
import { confirmSave, saveSources } from './saveSources';

const PATH = '/work/digest.config.json';
const added: Source[] = [{ id: 'new-feed', kind: 'rss', url: 'https://new.example.com/feed' }];
const base = {
  focusAreas: ['AI'],
  sources: [{ id: 'old', kind: 'rss', url: 'https://old.example.com/feed' }],
  topN: 4,
};

function files(text: string | undefined): {
  io: Parameters<typeof saveSources>[3];
  written: Map<string, string>;
} {
  const written = new Map<string, string>();
  return {
    written,
    io: {
      readFile: () => Promise.resolve(text),
      writeFile: (path, content) => {
        written.set(path, content);
        return Promise.resolve();
      },
    },
  };
}

describe('saveSources', () => {
  it('appends to the file sources and keeps every other key', async () => {
    const { io, written } = files(JSON.stringify(base));

    await saveSources(PATH, added, [], io);

    const saved = JSON.parse(written.get(PATH) ?? '{}') as typeof base;
    expect(saved.sources.map((s) => s.id)).toEqual(['old', 'new-feed']);
    expect(saved.topN).toBe(4);
    expect(saved.focusAreas).toEqual(['AI']);
    expect(written.get(PATH)).toMatch(/\n$/);
  });

  it('writes the running sources first when the file has none of its own', async () => {
    const { io, written } = files(JSON.stringify({ focusAreas: ['AI'] }));
    const current: Source[] = [{ id: 'default', kind: 'rss', url: 'https://d.example.com/f' }];

    await saveSources(PATH, added, current, io);

    const saved = JSON.parse(written.get(PATH) ?? '{}') as typeof base;
    expect(saved.sources.map((s) => s.id)).toEqual(['default', 'new-feed']);
  });

  it('refuses a result the schema rejects, and writes nothing', async () => {
    const { io, written } = files(JSON.stringify(base));
    const clash: Source[] = [{ id: 'old', kind: 'rss', url: 'https://x.example.com/f' }];

    await expect(saveSources(PATH, clash, [], io)).rejects.toThrow(/would not be valid/);
    expect(written.size).toBe(0);
  });

  it.each([
    [undefined, /does not exist/],
    ['{nope', /not valid JSON/],
    ['[1]', /must hold a JSON object/],
  ])('refuses a file that is %j', async (text, message) => {
    const { io, written } = files(text);

    await expect(saveSources(PATH, added, [], io)).rejects.toThrow(message);
    await expect(saveSources(PATH, added, [], io)).rejects.toBeInstanceOf(DigestError);
    expect(written.size).toBe(0);
  });
});

describe('confirmSave', () => {
  it('asks with the file name and defaults to no', async () => {
    const { prompts, calls } = scriptedPrompts();

    expect(await confirmSave(prompts, PATH)).toBe(false);
    expect(calls[0]?.message).toBe('Save to digest.config.json for future weeks?');
  });
});
