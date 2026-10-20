import type { LoadedConfig } from '../../../config/load';
import { DigestError } from '../../../shared/errors';

/** The seed is a whole number of 0 or more; commander checks it too, library callers may not. */
export function parseSeed(seed: number | undefined): number | undefined {
  if (seed === undefined) return undefined;
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new DigestError(`Invalid --seed "${seed}". Use a whole number of 0 or more.`);
  }
  return seed;
}

/** A new LoadedConfig whose models.seed is `seed`; the loaded one stays as it was. */
export function withSeed(loaded: LoadedConfig, seed: number | undefined): LoadedConfig {
  if (seed === undefined) return loaded;
  return {
    ...loaded,
    config: { ...loaded.config, models: { ...loaded.config.models, seed } },
  };
}

/** The folder for the digest files, as given. Blank is refused: the schema needs a real path. */
export function parseOut(out: string | undefined): string | undefined {
  if (out === undefined) return undefined;
  if (out.trim() === '') {
    throw new DigestError(
      `Invalid --out "${out}". Give the folder for the digest files, for example --out ./digests.`,
    );
  }
  return out;
}

/** A new LoadedConfig whose Markdown folder is `dir`; the loaded one stays as it was. */
export function withOut(loaded: LoadedConfig, dir: string | undefined): LoadedConfig {
  if (dir === undefined) return loaded;
  const { delivery } = loaded.config;
  return {
    ...loaded,
    config: {
      ...loaded.config,
      delivery: { ...delivery, markdown: { ...delivery.markdown, dir } },
    },
  };
}
