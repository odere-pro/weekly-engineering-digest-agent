import type { Sample } from './types';

/** Samples that share one fitted value: sums over `count` samples. */
export interface Block {
  rawSum: number;
  targetSum: number;
  count: number;
}

/** The knot a block becomes: its mean raw score and its mean target. */
export const blockValue = (block: Block): { raw: number; calibrated: number } => ({
  raw: block.rawSum / block.count,
  calibrated: block.targetSum / block.count,
});

/** Samples with the same raw score share one block, in rising raw order. */
export function groupByRaw(samples: readonly Sample[]): Block[] {
  const groups = new Map<number, Block>();
  for (const { raw, target } of samples) {
    const old = groups.get(raw) ?? { rawSum: 0, targetSum: 0, count: 0 };
    groups.set(raw, {
      rawSum: old.rawSum + raw,
      targetSum: old.targetSum + target,
      count: old.count + 1,
    });
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
}

/** Pool adjacent violators: merge neighbours until the block means never fall. */
export function pool(blocks: readonly Block[]): Block[] {
  const stack: Block[] = [];
  for (const block of blocks) {
    let current = block;
    for (
      let last = stack.at(-1);
      last && last.targetSum / last.count >= current.targetSum / current.count;
      last = stack.at(-1)
    ) {
      stack.pop();
      current = {
        rawSum: last.rawSum + current.rawSum,
        targetSum: last.targetSum + current.targetSum,
        count: last.count + current.count,
      };
    }
    stack.push(current);
  }
  return stack;
}
