import { measured, type Measurement } from '../measurement/measurement';
import { countBy } from '../measurement/numbers';

/** Share of weeks each writer won; the value is the leader's share. Reported, not gated. */
export function writerWinRate(winners: readonly string[]): Measurement {
  const shares = Object.entries(countBy(winners)).map(
    ([writer, wins]) => [writer, wins / winners.length] as const,
  );
  return measured(
    shares.length === 0 ? null : Math.max(...shares.map(([, s]) => s)),
    Object.fromEntries(shares),
  );
}
