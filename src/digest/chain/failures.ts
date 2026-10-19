import type { StepName } from '../../domain/schemas';
import { errorMessage } from '../../shared/errors';
import type { ChainState } from './state';

/** Carries the state the failed step started from, so the record keeps what ran before it. */
export class StepFailure extends Error {
  constructor(
    readonly step: StepName,
    readonly state: ChainState,
    cause: unknown,
  ) {
    super(errorMessage(cause), { cause });
    this.name = 'StepFailure';
  }
}

/** Thrown by a step that fails after part of its work, so the record keeps that part. */
export class PartialFailure extends Error {
  constructor(
    readonly state: ChainState,
    cause: unknown,
  ) {
    super(errorMessage(cause), { cause });
    this.name = 'PartialFailure';
  }
}
