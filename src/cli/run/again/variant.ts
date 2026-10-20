import type { LoadedConfig } from '../../../config/load';
import type { Item, Source } from '../../../domain/schemas';
import { ItemsFileSchema } from '../../../digest/ending/runFiles/runFiles';
import type { RunOptions } from '../../../digest/types';
import type { RunVariant } from '../../../digest/variant';
import { DigestError, errorMessage } from '../../../shared/errors';
import type { RunStore } from '../../../store/RunStore';
import type { RunRecord, VariantKind } from '../../../store/runRecord';
import { withSources } from '../flags/flags';
import { linkUrls } from './links';
import { askNewSources, sourcesOrThrow } from './newSources';
import { askPerspective, cleanTopic } from './perspective';
import type { AgainFlags, RunPrompts } from './types';

/** What `runDigest` is given for a variant, and the config the app must be built with. */
export interface VariantPlan {
  reuse: NonNullable<RunOptions['reuse']>;
  variant: RunVariant;
  loaded: LoadedConfig;
  /** The sources this run added (only for `add-sources`); the caller may offer to save them. */
  added: readonly Source[];
}

export interface VariantInput {
  previous: RunRecord | undefined;
  store: RunStore;
  weekId: string;
  prompts: RunPrompts;
  loaded: LoadedConfig;
  /** What the flags gave; the prompts ask for the rest. */
  flags: AgainFlags;
}

async function savedItems(store: RunStore, weekId: string): Promise<Item[]> {
  const text = await store.readArtifact(weekId, 'items.json');
  if (text === undefined) {
    throw new DigestError(`No saved items for ${weekId}; run it once without a variant first.`);
  }
  try {
    return ItemsFileSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new DigestError(`The saved items for ${weekId} cannot be read: ${errorMessage(error)}`);
  }
}

/** The first digest's item URLs: what was sent, else the links in the saved digest.md. */
async function keepUrlsOf(
  previous: RunRecord | undefined,
  store: RunStore,
  weekId: string,
): Promise<string[]> {
  if (previous && previous.sentUrls.length > 0) return [...previous.sentUrls];
  return linkUrls((await store.readArtifact(weekId, 'digest.md')) ?? '');
}

async function topicOf(input: VariantInput): Promise<string> {
  const { perspective } = input.flags;
  if (perspective === undefined) return askPerspective(input.prompts, input.loaded.config);
  const topic = cleanTopic(perspective);
  if (topic === undefined) {
    throw new DigestError('Invalid --perspective. Give a topic of 1 to 200 characters.');
  }
  return topic;
}

async function newSourcesOf(input: VariantInput): Promise<Source[]> {
  const existing = input.loaded.config.sources;
  const { addSource } = input.flags;
  if (addSource === undefined || addSource.length === 0) {
    return askNewSources(input.prompts, existing);
  }
  return sourcesOrThrow(addSource.join(','), existing);
}

/**
 * Turns the choice into what the run needs: the saved items to reuse, which sources to fetch, the
 * variant, and the config with any added sources (apply it before `buildApp`).
 */
export async function variantPlan(kind: VariantKind, input: VariantInput): Promise<VariantPlan> {
  const { store, weekId } = input;
  const items = await savedItems(store, weekId);
  const keepUrls = await keepUrlsOf(input.previous, store, weekId);
  const none: readonly Source[] = [];
  if (kind === 'enrich') {
    return { reuse: { items }, variant: { kind, keepUrls }, loaded: input.loaded, added: none };
  }
  if (kind === 'add-sources') {
    const added = await newSourcesOf(input);
    const ids = added.map((source) => source.id);
    return {
      reuse: { items, fetchSourceIds: ids },
      variant: { kind, addedSources: ids, keepUrls },
      loaded: withSources(input.loaded, added),
      added,
    };
  }
  const reuse = { items, fetchSourceIds: [] };
  if (kind === 'complete') {
    return { reuse, variant: { kind, keepUrls }, loaded: input.loaded, added: none };
  }
  const topic = await topicOf(input);
  return { reuse, variant: { kind, topic, keepUrls }, loaded: input.loaded, added: none };
}
