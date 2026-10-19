import { describe, expect, it } from 'vitest';
import { ARTIFACT_FILES, artifactFile } from './artifactFiles';
import { DIGEST_FILE, RUN_RECORD_FILE } from './runFolders';
import type { ArtifactName } from '../RunStore';
import { DigestError } from '../../shared/errors';

/**
 * Every `ArtifactName`, once. The record type makes a name added to the port fail typecheck here
 * until it is listed, and the first test fails at runtime if this list and the table disagree.
 */
const EVERY_ARTIFACT: Record<ArtifactName, true> = {
  'items.json': true,
  'scores.json': true,
  'drafts.json': true,
  'digest.md': true,
  'review.md': true,
  'error.json': true,
};
const NAMES = Object.keys(EVERY_ARTIFACT) as ArtifactName[];

describe('ARTIFACT_FILES', () => {
  it('has exactly the names of the ArtifactName type', () => {
    expect(Object.keys(ARTIFACT_FILES).sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)('maps %s to a plain file name in the week folder', (name) => {
    const file = ARTIFACT_FILES[name];

    expect(file).toMatch(/^[\w.-]+$/);
    expect(file).not.toContain('..');
  });

  it('maps every name to a different file', () => {
    expect(new Set(Object.values(ARTIFACT_FILES)).size).toBe(NAMES.length);
  });

  it('keeps digest.md the file that pruning keeps', () => {
    expect(ARTIFACT_FILES['digest.md']).toBe(DIGEST_FILE);
  });

  it('leaves run.json to the run record', () => {
    expect(Object.values(ARTIFACT_FILES)).not.toContain(RUN_RECORD_FILE);
  });
});

describe('artifactFile', () => {
  it.each(NAMES)('gives the file of %s', (name) => {
    expect(artifactFile(name)).toBe(ARTIFACT_FILES[name]);
  });

  it.each([
    ['a path out of the week folder', '../../evil.txt'],
    ['a nested path', 'sub/digest.md'],
    ['the run record', 'run.json'],
    ['an empty name', ''],
    ['a name that Object.prototype also has', 'constructor'],
    ['__proto__', '__proto__'],
    ['hasOwnProperty', 'hasOwnProperty'],
  ])('refuses %s', (_label, name) => {
    expect(() => artifactFile(name as ArtifactName)).toThrow(DigestError);
    expect(() => artifactFile(name as ArtifactName)).toThrow(`Unknown artifact name "${name}"`);
  });
});
