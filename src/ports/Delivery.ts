export interface DigestMessage {
  weekId: string;
  subject: string;
  markdown: string;
}

export interface FailureNote {
  weekId: string;
  step?: string;
  message: string;
}

/** A delivery channel. Recipients and endpoints come from config and secrets only. */
export interface Delivery {
  readonly id: 'markdown' | 'email' | 'slack';
  sendDigest(message: DigestMessage): Promise<void>;
  sendFailure(note: FailureNote): Promise<void>;
}
