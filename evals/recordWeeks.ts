// `pnpm eval:record`: freezes the last 6 ISO weeks of live feed output into evals/weeks/<week>/items.json (W2-03).
import { NotImplementedError } from '../src/shared/errors.js';

export function recordWeeks(_options: { weeks: number; outDir: string }): Promise<string[]> {
  throw new NotImplementedError('W2-03');
}
