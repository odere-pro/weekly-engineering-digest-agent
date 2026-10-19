import { DigestError } from '../../shared/errors';

/** Thrown for a request that cannot be answered; the message is printed as it is. */
export class ShowError extends DigestError {}
