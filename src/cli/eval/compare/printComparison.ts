// `digest eval --compare <a> <b>`: reads two saved scorecards and prints what changed. Runs nothing.
import { compareScorecards, parseScorecard } from '../../../../evals/compare';
import { DigestError, errorMessage } from '../../../shared/errors';
import { formatComparison } from './formatComparison';

/** The two things the comparison touches outside itself: reading a file, printing. */
export interface CompareIo {
  readFile: (path: string) => Promise<string>;
  stdout: (text: string) => void;
}

const COMPARE_FILE_COUNT = 2;

async function readScorecardFile(io: CompareIo, path: string): Promise<string> {
  try {
    return await io.readFile(path);
  } catch (error) {
    throw new DigestError(`Cannot read ${path}: ${errorMessage(error)}`, { cause: error });
  }
}

/** Prints the table for `paths`, which must name exactly two scorecard files; a DigestError otherwise. */
export async function printComparison(paths: readonly string[], io: CompareIo): Promise<void> {
  const [before, after] = paths;
  if (paths.length !== COMPARE_FILE_COUNT || before === undefined || after === undefined) {
    throw new DigestError('--compare needs two scorecard files: --compare <a.json> <b.json>');
  }
  const [textA, textB] = [await readScorecardFile(io, before), await readScorecardFile(io, after)];
  io.stdout(
    `${formatComparison(
      compareScorecards(parseScorecard(before, textA), parseScorecard(after, textB)),
      { before, after },
    )}\n`,
  );
}
