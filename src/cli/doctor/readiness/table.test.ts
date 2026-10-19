import { describe, expect, it } from 'vitest';
import {
  NON_MAC_FALLBACK,
  PROFILES,
  requiredModels,
  type Platform,
} from '../../../config/profiles';
import type { ModelHealth } from '../../../models/ModelProvider';
import { GIB, QUALITY_TIGHT_RAM } from './memory';
import { buildRow, type ProfileRow } from './rows';
import { machineLines, pullLines, render, tableLines, tightLines } from './table';
import type { Target } from './target';

const MAC: Platform = { os: 'darwin', arch: 'arm64' };
const LINUX: Platform = { os: 'linux', arch: 'x64' };
const ALL_TAGS = requiredModels(PROFILES.quality);
/** Every model of every row, so each row on a big Mac is ready. */
const EVERY_TAG = [
  ...new Set([
    ...ALL_TAGS,
    ...requiredModels(PROFILES.fast),
    ...requiredModels(PROFILES.light),
    ...requiredModels({ ...NON_MAC_FALLBACK, name: 'light' }),
  ]),
];
const READY: ModelHealth = {
  reachable: true,
  version: '0.40.4',
  models: EVERY_TAG.map((name) => ({ name, capabilities: [] })),
};
const TARGET: Target = {
  dataDir: './data',
  ollamaUrl: 'http://localhost:11434',
  platform: MAC,
  configNote: undefined,
};
const IO = { totalMemoryBytes: 64 * GIB, nodeVersion: 'v24.1.0' };
const DISK = { data: 120 * GIB, models: 50 * GIB };

function rows(health: ModelHealth, platform: Platform = MAC, ram = 64 * GIB): ProfileRow[] {
  return (['quality', 'fast', 'light', 'fallback'] as const).map((name) =>
    buildRow(name, platform, ram, health),
  );
}

describe('tableLines', () => {
  it('prints a header and one line per row, columns aligned, no trailing spaces', () => {
    const lines = tableLines(rows(READY));

    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(
      /^ {2}profile +RAM fits +Apple silicon +Ollama version +models +verdict$/,
    );
    for (const line of lines) expect(line).toBe(line.trimEnd());
    const verdictColumn = lines[0]?.indexOf('verdict');
    for (const line of lines.slice(1)) {
      expect(line.indexOf('ready')).toBe(verdictColumn);
    }
  });

  it('says whether Apple silicon is needed and present', () => {
    const present = tableLines(rows(READY, MAC)).join('\n');
    const missing = tableLines(rows(READY, LINUX)).join('\n');

    expect(present).toContain('needed, present');
    expect(missing).toContain('needed, missing');
    expect(present).toContain('not needed');
  });

  it('marks a RAM fit it did not measure', () => {
    const lines = tableLines(rows(READY));

    expect(lines.find((l) => l.trimStart().startsWith('fast'))).toContain('yes (not measured)');
    expect(lines.find((l) => l.trimStart().startsWith('quality'))).not.toContain('not measured');
  });

  it('shows quality as tight, with a "tight on RAM" verdict, on a 32 GiB Mac', () => {
    const lines = tableLines(rows(READY, MAC, 32 * GIB));
    const quality = lines.find((l) => l.trimStart().startsWith('quality'));
    const light = lines.find((l) => l.trimStart().startsWith('light'));

    expect(quality).toMatch(/^ {2}quality +tight +needed, present .* tight on RAM$/);
    expect(light).toMatch(/ yes +needed, present .* ready$/);
  });

  it('keeps every column aligned when the verdict is the longest cell', () => {
    const lines = tableLines(rows(READY, MAC, 32 * GIB));
    const verdictColumn = lines[0]?.indexOf('verdict');

    expect(lines.find((l) => l.includes('tight on RAM'))?.indexOf('tight on RAM')).toBe(
      verdictColumn,
    );
  });

  it('shows the version verdict with the minimum', () => {
    const ok = tableLines(rows(READY)).join('\n');
    const old = tableLines(rows({ ...READY, version: '0.30.0' })).join('\n');
    const unknown = tableLines(rows({ ...READY, version: undefined })).join('\n');

    expect(ok).toContain('ok (min 0.40.0)');
    expect(old).toContain('too old (min 0.40.0)');
    expect(unknown).toContain('unknown (min 0.40.0)');
  });

  it('counts the installed models, or says unknown when they could not be listed', () => {
    const count = String(ALL_TAGS.length);
    const listed = tableLines(rows(READY)).join('\n');
    const unlisted = tableLines(rows({ reachable: false, models: [] })).join('\n');

    expect(listed).toContain(`${count} of ${count} installed`);
    expect(unlisted).toContain(`unknown of ${count}`);
  });
});

describe('pullLines', () => {
  it('is empty when no row needs a pull', () => {
    expect(pullLines(rows(READY), READY)).toEqual([]);
  });

  it('lists an ollama pull per missing tag under the row, after a blank line', () => {
    const health = { ...READY, models: [{ name: 'clef:latest', capabilities: [] }] };

    const lines = pullLines(rows(health), health);

    expect(lines[0]).toBe('');
    expect(lines[1]).toBe('To get quality ready:');
    expect(lines).toContain('  ollama pull gemma4:31b-mlx');
    expect(lines).not.toContain('  ollama pull clef:latest');
  });

  it('adds an update line for an Ollama that is too old', () => {
    const health = { ...READY, version: '0.30.0' };

    expect(pullLines(rows(health), health)).toContain('  update Ollama to 0.40.0 or later');
  });

  it('adds a start line when Ollama is not reachable', () => {
    const health: ModelHealth = { reachable: false, models: [] };

    expect(pullLines(rows(health), health)).toContain(
      '  start Ollama ("ollama serve"), then re-run this check',
    );
  });

  it('skips the rows that are ready or not for this machine', () => {
    const health = { ...READY, models: [] };

    const lines = pullLines(rows(health, LINUX), health);

    expect(lines.filter((l) => l.startsWith('To get'))).toEqual(['To get fallback ready:']);
  });
});

describe('tightLines', () => {
  it('is empty when no row is tight', () => {
    expect(tightLines(rows(READY), 64 * GIB)).toEqual([]);
    expect(tightLines(rows(READY, MAC, 48 * GIB), 48 * GIB)).toEqual([]);
    expect(tightLines(rows(READY, MAC, 16 * GIB), 16 * GIB)).toEqual([]);
  });

  it('says after a blank line why quality is tight, with the measured numbers init quotes', () => {
    const lines = tightLines(rows(READY, MAC, 32 * GIB), 32 * GIB);

    expect(lines).toEqual(['', `quality is tight on 32.0 GiB of RAM: ${QUALITY_TIGHT_RAM}.`]);
  });

  it('names the RAM this process sees, to one decimal', () => {
    const bytes = 31.04 * GIB;

    expect(tightLines(rows(READY, MAC, bytes), bytes).join('\n')).toContain('31.0 GiB of RAM');
  });
});

describe('machineLines', () => {
  const base = {
    target: TARGET,
    health: READY,
    io: IO,
    modelsDir: '/home/me/.ollama/models',
    disk: DISK,
  };

  it('lists OS, Apple silicon, RAM, disks, Node and Ollama, values aligned', () => {
    const lines = machineLines(base);

    expect(lines.map((l) => l.replace(/\s+/g, ' ').trim())).toEqual([
      'OS: darwin (arm64)',
      'Apple silicon: yes',
      'RAM (seen by this process): 64.0 GiB',
      'Free disk, data dir (./data): 120.0 GiB',
      'Free disk, Ollama models (/home/me/.ollama/models): 50.0 GiB',
      'Node: v24.1.0',
      'Ollama: 0.40.4 at http://localhost:11434',
    ]);
    const valueColumns = new Set(lines.map((l) => /^ {2}.*?: +/.exec(l)?.[0].length));
    expect(valueColumns.has(undefined)).toBe(false);
    expect(valueColumns.size).toBe(1);
  });

  it('leaves out the models folder of a remote Ollama', () => {
    const lines = machineLines({ ...base, modelsDir: undefined });

    expect(lines.join('\n')).not.toContain('Ollama models');
  });

  it('prints "unknown" for a disk it could not read', () => {
    const lines = machineLines({ ...base, disk: { data: undefined, models: undefined } });

    expect(lines.filter((l) => l.endsWith('unknown'))).toHaveLength(2);
  });

  it('says where Ollama was not reachable, with the reason', () => {
    const health: ModelHealth = { reachable: false, models: [], error: 'connection refused' };

    const lines = machineLines({ ...base, health });

    expect(lines.at(-1)).toContain('not reachable at http://localhost:11434 (connection refused)');
  });

  it('adds the model-listing error of an Ollama that answered', () => {
    const health: ModelHealth = { ...READY, error: 'tags failed' };

    const lines = machineLines({ ...base, health });

    expect(lines.at(-1)).toMatch(/Ollama models:\s+tags failed/);
  });

  it('shows Apple silicon "no" for a Linux host', () => {
    const lines = machineLines({ ...base, target: { ...TARGET, platform: LINUX } });

    expect(lines[1]).toMatch(/Apple silicon:\s+no/);
  });
});

describe('render', () => {
  const input = {
    target: TARGET,
    health: READY,
    rows: rows(READY),
    io: IO,
    modelsDir: undefined,
    disk: DISK,
  };

  it('prints Machine, a blank line, Profiles and the table, ending in a blank line', () => {
    const text = render(input);

    expect(text.startsWith('Machine\n')).toBe(true);
    expect(text).toContain('\n\nProfiles\n');
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('puts the config note, then a blank line, before everything else', () => {
    const text = render({ ...input, target: { ...TARGET, configNote: 'no config used (boom)' } });

    expect(text.startsWith('! no config used (boom)\n\nMachine\n')).toBe(true);
  });

  it('adds why quality is tight after the table and before the pull lists', () => {
    const health: ModelHealth = { ...READY, models: [{ name: 'clef:latest', capabilities: [] }] };
    const bytes = 32 * GIB;

    const text = render({
      ...input,
      health,
      rows: rows(health, MAC, bytes),
      io: { ...IO, totalMemoryBytes: bytes },
    });

    expect(text).toContain(`quality is tight on 32.0 GiB of RAM: ${QUALITY_TIGHT_RAM}.`);
    expect(text.indexOf('Profiles')).toBeLessThan(text.indexOf('quality is tight'));
    expect(text.indexOf('quality is tight')).toBeLessThan(text.indexOf('To get quality ready:'));
  });

  it('prints no tight line when RAM is not tight', () => {
    expect(render(input)).not.toContain('is tight');
  });

  it('adds the pull lists after the table', () => {
    const health: ModelHealth = { reachable: false, models: [] };

    const text = render({ ...input, health, rows: rows(health) });

    expect(text.indexOf('Profiles')).toBeLessThan(text.indexOf('To get quality ready:'));
  });
});
