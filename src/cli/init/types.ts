import type { ConfigInput, ProfileName } from '../../config/schema';
import type { OsSchedule, OsScheduleOptions } from '../../scheduler/osSchedule';
import type { Clock } from '../../shared/clock';

export interface InitCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
  /** Accept defaults without prompting. */
  yes?: boolean;
}

/** Returns true when the answer is acceptable, otherwise the message to show. */
export type Validate = (value: string) => true | string;

/** The ticked choices of a checkbox question: true when they are acceptable, else the message to show. */
export type ValidateSelection = (selected: readonly { value: string }[]) => true | string;

export interface InitPrompts {
  confirm(options: { message: string; default: boolean }): Promise<boolean>;
  checkbox(options: {
    message: string;
    choices: readonly { name: string; value: string; checked?: boolean }[];
    validate?: ValidateSelection;
  }): Promise<string[]>;
  input(options: { message: string; default?: string; validate?: Validate }): Promise<string>;
  select<T extends string>(options: {
    message: string;
    choices: readonly { name: string; value: T; description?: string }[];
    default: T;
  }): Promise<T>;
  password(options: { message: string; validate?: Validate }): Promise<string>;
}

/** Everything the command touches outside itself; tests replace it, `digest init` uses the defaults. */
export interface InitIo {
  prompts: InitPrompts;
  /** Process environment; only DIGEST_HOST_OS is read. */
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  totalMemoryBytes: number;
  /** What a container is limited to (cgroup), in bytes; 0 or unset when there is no limit. */
  memoryLimitBytes?: number;
  /** The IANA zone this process runs in; the default for `schedule.timeZone`. */
  timeZone: string;
  /** What "now" is: it names the week folder the questions and the summary show. */
  clock: Clock;
  /** The folder digest runs from: a relative `dataDir` is resolved against it. */
  cwd: string;
  /** Where the secrets file goes; digest loads ./.env. */
  envPath: string;
  /** How a scheduler starts digest, without arguments, e.g. "/usr/local/bin/digest". */
  scheduleProgram: string;
  renderSchedule: (os: NodeJS.Platform, options: OsScheduleOptions) => OsSchedule;
  /** False only for a path known to be missing; one it cannot check counts as there. */
  exists: (path: string) => Promise<boolean>;
  /** True for an existing file with no content, such as the ones `make docker-init` creates. */
  isEmptyFile: (path: string) => Promise<boolean>;
  /** The text of a file, undefined when it does not exist. Other failures reject. */
  readFile: (path: string) => Promise<string | undefined>;
  /** Writes a normal file, creating its folder. */
  writeFile: (path: string, content: string) => Promise<void>;
  /**
   * Writes a file that only its owner can read (mode 0600), replacing any existing file. Goes
   * through a temp file and a rename; where that is impossible (a single-file bind mount in
   * Docker, a read-only folder) it writes the existing file in place.
   */
  writeSecretFile: (path: string, content: string) => Promise<void>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Where init runs and, in a container, the OS of the machine that runs Ollama. */
export interface Host {
  inDocker: boolean;
  hostOs: string | undefined;
}

export interface EmailAnswers {
  delivery: NonNullable<ConfigInput['delivery']>['email'];
  password: string;
}

/** What the user chose (or the defaults): the input of the config file, `.env` and the summary. */
export interface Answers {
  profile: ProfileName;
  timeZone: string;
  focusAreas: string[];
  email?: EmailAnswers;
  slackWebhook?: string;
}
