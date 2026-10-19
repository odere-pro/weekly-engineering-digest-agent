// What the two commands need from the outside, so tests can pass fakes.
import type { ProfileName, Thresholds } from '../../../src/config/schema';
import type { Clock } from '../../../src/shared/clock';
import type { CaptureDeps } from '../capture/captureRaw';
import type { RawCapture } from '../capture/schemas';
import type { EvalSet } from '../capture/subjects';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** What `capture` needs from a config file: the profile's models and guards, wired as for a run. */
export interface CaptureSession {
  profile: ProfileName;
  models: RawCapture['models'];
  ollamaVersion: string | null;
  baseline: Thresholds;
  deps: Omit<CaptureDeps, 'clock' | 'progress'>;
  close(): Promise<void>;
}

export interface CliIo {
  /** Folder with weeks/, classifier-cases.json, attacks/ and grounding/. */
  casesDir: string;
  /** Sweep results go here, raw captures to its raw/ folder. */
  outDir: string;
  openCapture: (configPath: string | undefined) => Promise<CaptureSession>;
  loadEvalSet: (casesDir: string) => Promise<EvalSet>;
  clock: Clock;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}
