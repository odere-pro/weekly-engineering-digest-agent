import { DigestError } from '../shared/errors';
import { parseSimpleCron, type SimpleCron } from './simpleCron';

export interface OsScheduleOptions {
  cron: string;
  /**
   * Absolute command line, e.g. "/usr/local/bin/digest run". It is written as is, so the caller
   * quotes it for the target OS. On Windows it may not contain quotes or cmd.exe operators.
   */
  command: string;
  workingDir: string;
}

export interface OsSchedule {
  /**
   * Where the file should be installed. On Linux this is the timer; the content holds the
   * service unit too, each under a "# <path>" header. On Windows there is no file, so this is
   * the Task Scheduler task name.
   */
  path: string;
  content: string;
  /** Command(s) the user runs to activate it, and where the schedule's time zone comes from. */
  installHint: string;
}

const LABEL = 'dev.eng-digest.weekly';
const LAUNCHD_PATH = `~/Library/LaunchAgents/${LABEL}.plist`;
const SYSTEMD_DIR = '~/.config/systemd/user';
/** Monday first, matching the ISO numbers in SimpleCron.weekdays. */
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CONTROL_CHARACTERS = /\p{Cc}/u;
/** cmd.exe operators and the quote the Task Scheduler line cannot carry safely. */
const CMD_SPECIAL_CHARACTERS = /["&|<>^%]/;
const LOCAL_TIME_NOTE = "It fires in the machine's local time zone, not schedule.timeZone.";

/** launchd plist (macOS), systemd timer (Linux) or Task Scheduler entry (Windows) (W1-16). */
export function renderOsSchedule(os: NodeJS.Platform, options: OsScheduleOptions): OsSchedule {
  const renderer = RENDERERS[os as keyof typeof RENDERERS] as Renderer | undefined;
  if (renderer === undefined) {
    throw new DigestError(
      `No OS schedule is generated for "${os}". Run "digest run" weekly from your own scheduler.`,
    );
  }
  assertSafeValue('command', options.command);
  assertSafeValue('working directory', options.workingDir);
  return renderer(parseSimpleCron(options.cron), options);
}

type Renderer = (cron: SimpleCron, options: OsScheduleOptions) => OsSchedule;

const RENDERERS = { darwin: renderLaunchd, linux: renderSystemd, win32: renderTaskScheduler };

/** Values land in unit files and command lines, so keep out anything that changes their shape. */
function assertSafeValue(label: string, value: string): void {
  if (value.trim() === '') {
    throw new DigestError(`The ${label} for the OS schedule must not be empty.`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new DigestError(`The ${label} for the OS schedule must be a single line of text.`);
  }
  if (value.endsWith('\\')) {
    throw new DigestError(`The ${label} for the OS schedule must not end with a backslash.`);
  }
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

function weekdayLabels(cron: SimpleCron): string[] {
  return (cron.weekdays ?? []).map((day) => WEEKDAY_LABELS[day - 1] ?? '');
}

function renderLaunchd(cron: SimpleCron, options: OsScheduleOptions): OsSchedule {
  const intervals = (cron.weekdays ?? [null]).map((day) => launchdInterval(cron, day));
  const calendar =
    intervals.length === 1
      ? (intervals[0] ?? '')
      : ['  <array>', ...intervals.map(indent), '  </array>'].join('\n');
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>\n  <string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    '    <string>-c</string>',
    `    <string>${escapeXml(options.command)}</string>`,
    '  </array>',
    `  <key>WorkingDirectory</key>\n  <string>${escapeXml(options.workingDir)}</string>`,
    `  <key>StartCalendarInterval</key>\n${calendar}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  return {
    path: LAUNCHD_PATH,
    content,
    installHint: `launchctl bootstrap gui/$(id -u) ${LAUNCHD_PATH}. ${LOCAL_TIME_NOTE}`,
  };
}

/** One `<dict>` of StartCalendarInterval; launchd counts Sunday as 0. */
function launchdInterval(cron: SimpleCron, isoDay: number | null): string {
  const weekday =
    isoDay === null ? [] : [`    <key>Weekday</key>\n    <integer>${isoDay % 7}</integer>`];
  return [
    '  <dict>',
    ...weekday,
    `    <key>Hour</key>\n    <integer>${cron.hour}</integer>`,
    `    <key>Minute</key>\n    <integer>${cron.minute}</integer>`,
    '  </dict>',
  ].join('\n');
}

const indent = (block: string): string =>
  block
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderSystemd(cron: SimpleCron, options: OsScheduleOptions): OsSchedule {
  const servicePath = `${SYSTEMD_DIR}/${LABEL}.service`;
  const timerPath = `${SYSTEMD_DIR}/${LABEL}.timer`;
  const days = weekdayLabels(cron).join(',');
  const onCalendar = `${days === '' ? '' : `${days} `}*-*-* ${pad2(cron.hour)}:${pad2(cron.minute)}:00`;
  const content = [
    `# ${servicePath}`,
    '[Unit]',
    'Description=Weekly engineering digest',
    '',
    '[Service]',
    'Type=oneshot',
    `WorkingDirectory=${escapeSpecifiers(options.workingDir)}`,
    `ExecStart=${escapeSpecifiers(options.command).replaceAll('$', () => '$$')}`,
    '',
    `# ${timerPath}`,
    '[Unit]',
    'Description=Weekly engineering digest schedule',
    '',
    '[Timer]',
    `OnCalendar=${onCalendar}`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
  return {
    path: timerPath,
    content,
    installHint:
      `Save each section to the path in its header, then run: ` +
      `systemctl --user daemon-reload && systemctl --user enable --now ${LABEL}.timer. ` +
      LOCAL_TIME_NOTE,
  };
}

/** systemd reads "%x" in unit values as a specifier; "%%" is a literal percent sign. */
const escapeSpecifiers = (text: string): string => text.replaceAll('%', '%%');

function renderTaskScheduler(cron: SimpleCron, options: OsScheduleOptions): OsSchedule {
  assertCmdSafe('command', options.command);
  assertCmdSafe('working directory', options.workingDir);
  const days = weekdayLabels(cron)
    .map((label) => label.toUpperCase())
    .join(',');
  const frequency = days === '' ? '/SC DAILY' : `/SC WEEKLY /D ${days}`;
  const action = `cmd /c cd /d \\"${options.workingDir}\\" && ${options.command}`;
  const content =
    `schtasks /Create /TN "${LABEL}" ${frequency} ` +
    `/ST ${pad2(cron.hour)}:${pad2(cron.minute)} /TR "${action}" /F`;
  return {
    path: LABEL,
    content,
    installHint:
      `Paste the line above into Command Prompt (cmd.exe), not PowerShell. ${LOCAL_TIME_NOTE} ` +
      `Remove the task with: schtasks /Delete /TN "${LABEL}" /F`,
  };
}

function assertCmdSafe(label: string, value: string): void {
  if (CMD_SPECIAL_CHARACTERS.test(value)) {
    throw new DigestError(
      `The ${label} for the Windows schedule contains a quote or one of & | < > ^ %, which ` +
        'cmd.exe would act on. Use a path without them, or point at a wrapper script.',
    );
  }
}
