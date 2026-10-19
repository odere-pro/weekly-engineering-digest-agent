import { describe, expect, it } from 'vitest';
import { DigestError } from '../../../shared/errors';
import { CONFIG_PATH, ENV_PATH, harness, type HarnessOptions } from '../__fixtures__/initHarness';
import { confirmOverwrite } from './confirmOverwrite';

/** Runs the check on a fake machine; returns what it threw (if anything) and what it asked. */
async function check(paths: string[], yes: boolean, options: HarnessOptions = {}) {
  const h = harness(options);
  const failure = await confirmOverwrite(paths, yes, h.io).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { failure, calls: h.calls };
}

describe('confirmOverwrite', () => {
  it('does nothing when no file is there', async () => {
    const { failure, calls } = await check([CONFIG_PATH], false);

    expect(failure).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('asks first, naming the existing file, with "no" as the default', async () => {
    const { calls } = await check([CONFIG_PATH], false, {
      existing: [CONFIG_PATH],
      rules: [[/Overwrite/, true]],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe('confirm');
    expect(calls[0]?.message).toBe(`Overwrite ${CONFIG_PATH}?`);
    expect(calls[0]?.options.default).toBe(false);
  });

  it('goes on after a yes', async () => {
    const { failure } = await check([CONFIG_PATH], false, {
      existing: [CONFIG_PATH],
      rules: [[/Overwrite/, true]],
    });

    expect(failure).toBeUndefined();
  });

  it('stops after a no, saying the file was kept and nothing was written', async () => {
    const { failure } = await check([CONFIG_PATH], false, {
      existing: [CONFIG_PATH],
      rules: [[/Overwrite/, false]],
    });

    expect(failure).toBeInstanceOf(DigestError);
    expect((failure as DigestError).message).toBe(`Kept ${CONFIG_PATH}. Nothing was written.`);
  });

  it('keeps the files when the user just presses Enter', async () => {
    const { failure } = await check([CONFIG_PATH], false, { existing: [CONFIG_PATH] });

    expect(failure).toBeInstanceOf(DigestError);
  });

  it('asks once for several files and names each of them', async () => {
    const { calls } = await check([CONFIG_PATH, ENV_PATH], false, {
      existing: [CONFIG_PATH, ENV_PATH],
      rules: [[/Overwrite/, true]],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe(`Overwrite ${CONFIG_PATH} and ${ENV_PATH}?`);
  });

  it('refuses under --yes without asking, naming the file and the way out', async () => {
    const { failure, calls } = await check([CONFIG_PATH], true, { existing: [CONFIG_PATH] });

    expect(calls).toEqual([]);
    expect((failure as DigestError).message).toBe(
      `Refusing to overwrite ${CONFIG_PATH} with --yes. Move it away, or run "digest init" without --yes to confirm.`,
    );
  });

  it('lets --yes through when nothing is there', async () => {
    const { failure } = await check([CONFIG_PATH], true);

    expect(failure).toBeUndefined();
  });

  it('counts an empty file as absent, as make docker-init leaves them', async () => {
    const { failure, calls } = await check([CONFIG_PATH, ENV_PATH], true, {
      empty: [CONFIG_PATH, ENV_PATH],
    });

    expect(failure).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('does not ask about an empty file', async () => {
    const { calls } = await check([CONFIG_PATH], false, { empty: [CONFIG_PATH] });

    expect(calls).toEqual([]);
  });

  it('still refuses a file with content, and names only that one', async () => {
    const { failure } = await check([CONFIG_PATH, ENV_PATH], true, {
      existing: [CONFIG_PATH],
      empty: [ENV_PATH],
    });

    const message = (failure as DigestError).message;
    expect(message).toContain(CONFIG_PATH);
    expect(message).not.toContain(ENV_PATH);
  });

  it('asks about the files with content only', async () => {
    const { calls } = await check([CONFIG_PATH, ENV_PATH], false, {
      existing: [CONFIG_PATH],
      empty: [ENV_PATH],
      rules: [[/Overwrite/, true]],
    });

    expect(calls[0]?.message).toContain(CONFIG_PATH);
    expect(calls[0]?.message).not.toContain(ENV_PATH);
  });
});
