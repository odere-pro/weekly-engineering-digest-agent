import { describe, expect, it } from 'vitest';
import { renderOsSchedule, type OsScheduleOptions } from './osSchedule';
import { DigestError } from '../shared/errors';

const BASE: OsScheduleOptions = {
  cron: '45 7 * * 1',
  command: '/usr/local/bin/digest run',
  workingDir: '/Users/ada/digest',
};

function options(overrides: Partial<OsScheduleOptions> = {}): OsScheduleOptions {
  return { ...BASE, ...overrides };
}

describe('renderOsSchedule darwin', () => {
  it('writes a launchd agent that runs the command on the weekly slot', () => {
    const result = renderOsSchedule('darwin', options());

    expect(result.path).toBe('~/Library/LaunchAgents/dev.eng-digest.weekly.plist');
    expect(result.content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(result.content).toContain('<key>Label</key>');
    expect(result.content).toContain('<string>dev.eng-digest.weekly</string>');
    expect(result.content).toContain('<string>/usr/local/bin/digest run</string>');
    expect(result.content).toContain('<key>WorkingDirectory</key>');
    expect(result.content).toContain('<string>/Users/ada/digest</string>');
    expect(result.content).toContain('<key>StartCalendarInterval</key>');
    expect(result.content).toMatch(/<key>Weekday<\/key>\s*<integer>1<\/integer>/);
    expect(result.content).toMatch(/<key>Hour<\/key>\s*<integer>7<\/integer>/);
    expect(result.content).toMatch(/<key>Minute<\/key>\s*<integer>45<\/integer>/);
    expect(result.installHint).toContain('launchctl');
    expect(result.installHint).toContain(result.path);
  });

  it('hands the whole command line to /bin/sh as a single argument', () => {
    const { content } = renderOsSchedule(
      'darwin',
      options({ command: '/opt/my tools/digest run' }),
    );

    expect(content).toMatch(/<string>\/bin\/sh<\/string>\s*<string>-c<\/string>/);
    expect(content).toContain('<string>/opt/my tools/digest run</string>');
  });

  it('escapes XML in the command and the working directory', () => {
    const { content } = renderOsSchedule(
      'darwin',
      options({ command: 'digest run && echo "<done>"', workingDir: '/tmp/a&b' }),
    );

    expect(content).toContain('digest run &amp;&amp; echo &quot;&lt;done&gt;&quot;');
    expect(content).toContain('<string>/tmp/a&amp;b</string>');
  });

  it('lists one interval per weekday', () => {
    const { content } = renderOsSchedule('darwin', options({ cron: '0 9 * * 1-3' }));

    expect(content.match(/<key>Weekday<\/key>/g)).toHaveLength(3);
    expect(content).toMatch(/<array>\s*<dict>/);
    expect(content).toMatch(/<integer>2<\/integer>/);
  });

  it('omits the weekday for a daily schedule', () => {
    const { content } = renderOsSchedule('darwin', options({ cron: '30 6 * * *' }));

    expect(content).not.toContain('<key>Weekday</key>');
    expect(content).toMatch(/<key>Hour<\/key>\s*<integer>6<\/integer>/);
    expect(content).toMatch(/<key>Minute<\/key>\s*<integer>30<\/integer>/);
  });
});

describe('renderOsSchedule linux', () => {
  it('writes a systemd user service and timer', () => {
    const result = renderOsSchedule('linux', options());

    expect(result.path).toBe('~/.config/systemd/user/dev.eng-digest.weekly.timer');
    expect(result.content).toContain('# ~/.config/systemd/user/dev.eng-digest.weekly.service');
    expect(result.content).toContain('# ~/.config/systemd/user/dev.eng-digest.weekly.timer');
    expect(result.content).toContain('[Service]');
    expect(result.content).toContain('Type=oneshot');
    expect(result.content).toContain('WorkingDirectory=/Users/ada/digest');
    expect(result.content).toContain('ExecStart=/usr/local/bin/digest run');
    expect(result.content).toContain('[Timer]');
    expect(result.content).toContain('OnCalendar=Mon *-*-* 07:45:00');
    expect(result.content).toContain('Persistent=true');
    expect(result.content).toContain('WantedBy=timers.target');
    expect(result.installHint).toContain('systemctl --user');
    expect(result.installHint).toContain('dev.eng-digest.weekly.timer');
  });

  it('lists several weekdays', () => {
    const { content } = renderOsSchedule('linux', options({ cron: '5 18 * * 1,3,5' }));

    expect(content).toContain('OnCalendar=Mon,Wed,Fri *-*-* 18:05:00');
  });

  it('runs every day when the weekday is a star', () => {
    const { content } = renderOsSchedule('linux', options({ cron: '0 6 * * *' }));

    expect(content).toContain('OnCalendar=*-*-* 06:00:00');
  });

  it('doubles percent signs, which systemd reads as specifiers', () => {
    const { content } = renderOsSchedule(
      'linux',
      options({ command: '/usr/bin/date +%F', workingDir: '/srv/100%' }),
    );

    expect(content).toContain('ExecStart=/usr/bin/date +%%F');
    expect(content).toContain('WorkingDirectory=/srv/100%%');
  });

  it('doubles dollar signs, which systemd would expand as variables', () => {
    const { content } = renderOsSchedule(
      'linux',
      options({ command: "/bin/sh -c 'cd $HOME && digest run'" }),
    );

    expect(content).toContain("ExecStart=/bin/sh -c 'cd $$HOME && digest run'");
  });
});

describe('renderOsSchedule win32', () => {
  it('writes a schtasks line for the weekly slot', () => {
    const result = renderOsSchedule(
      'win32',
      options({ command: 'C:\\digest\\digest.cmd run', workingDir: 'C:\\Users\\ada\\digest' }),
    );

    expect(result.path).toBe('dev.eng-digest.weekly');
    expect(result.content).toMatch(/^schtasks \/Create /);
    expect(result.content).toContain('/TN "dev.eng-digest.weekly"');
    expect(result.content).toContain('/SC WEEKLY');
    expect(result.content).toContain('/D MON');
    expect(result.content).toContain('/ST 07:45');
    expect(result.content).toContain(
      '/TR "cmd /c cd /d \\"C:\\Users\\ada\\digest\\" && C:\\digest\\digest.cmd run"',
    );
    expect(result.content).toMatch(/\/F$/);
    expect(result.installHint).toContain('schtasks');
  });

  it('lists several weekdays', () => {
    const { content } = renderOsSchedule('win32', options({ cron: '0 9 * * 0,6' }));

    expect(content).toContain('/D SAT,SUN');
  });

  it('runs daily when the weekday is a star', () => {
    const { content } = renderOsSchedule('win32', options({ cron: '15 8 * * *' }));

    expect(content).toContain('/SC DAILY');
    expect(content).not.toContain('/D ');
    expect(content).toContain('/ST 08:15');
  });
});

describe('renderOsSchedule cron parsing', () => {
  it('reads weekday names in any case', () => {
    const { content } = renderOsSchedule('linux', options({ cron: '0 7 * * mon-wed' }));

    expect(content).toContain('OnCalendar=Mon,Tue,Wed *-*-* 07:00:00');
  });

  it('treats 0 and 7 as Sunday and removes duplicates', () => {
    const { content } = renderOsSchedule('linux', options({ cron: '0 7 * * 7,0' }));

    expect(content).toContain('OnCalendar=Sun *-*-* 07:00:00');
  });

  it('accepts a range that crosses the weekend through 7', () => {
    const { content } = renderOsSchedule('linux', options({ cron: '0 7 * * 5-7' }));

    expect(content).toContain('OnCalendar=Fri,Sat,Sun *-*-* 07:00:00');
  });

  it('tolerates extra spaces', () => {
    const { content } = renderOsSchedule('linux', options({ cron: '  45   7 *  * 1 ' }));

    expect(content).toContain('OnCalendar=Mon *-*-* 07:45:00');
  });

  it.each([
    ['a step', '*/15 7 * * 1'],
    ['a minute list', '0,30 7 * * 1'],
    ['a minute star', '* 7 * * 1'],
    ['an hour range', '0 7-9 * * 1'],
    ['a day of month', '0 7 1 * *'],
    ['a month', '0 7 * 6 *'],
    ['an alias', '@weekly'],
    ['too few fields', '45 7 * *'],
    ['too many fields', '0 45 7 * * 1'],
    ['an hour out of range', '0 24 * * 1'],
    ['a minute out of range', '60 7 * * 1'],
    ['a weekday out of range', '0 7 * * 8'],
    ['a reversed range', '0 7 * * 5-1'],
    ['an unknown weekday', '0 7 * * funday'],
    ['a weekday step', '0 7 * * 1-5/2'],
    ['an empty list item', '0 7 * * 1,,3'],
  ])('rejects %s with a clear error that names the cron', (_label, cron) => {
    for (const os of ['darwin', 'linux', 'win32'] as const) {
      const error = (() => {
        try {
          renderOsSchedule(os, options({ cron }));
        } catch (e) {
          return e;
        }
        return undefined;
      })();

      expect(error).toBeInstanceOf(DigestError);
      expect((error as DigestError).message).toContain(cron.trim());
      expect((error as DigestError).message).toMatch(/digest run/);
    }
  });

  it.each([
    ['command', { command: 'digest run\nExecStartPost=/bin/evil' }],
    ['working directory', { workingDir: '/tmp\nUser=root' }],
  ])('rejects a newline in the %s', (label, overrides) => {
    expect(() => renderOsSchedule('linux', options(overrides))).toThrow(DigestError);
    expect(() => renderOsSchedule('linux', options(overrides))).toThrow(new RegExp(label));
  });

  it.each([
    ['command', { command: '   ' }],
    ['working directory', { workingDir: '' }],
  ])('rejects an empty %s', (label, overrides) => {
    expect(() => renderOsSchedule('linux', options(overrides))).toThrow(
      new RegExp(`${label}.*must not be empty`),
    );
  });

  it.each([
    ['command', { command: '/usr/local/bin/digest run\\' }],
    ['working directory', { workingDir: '/srv/digest\\' }],
  ])(
    'rejects a backslash at the end of the %s, which systemd reads as a line join',
    (label, overrides) => {
      for (const os of ['darwin', 'linux', 'win32'] as const) {
        expect(() => renderOsSchedule(os, options(overrides))).toThrow(
          new RegExp(`${label}.*backslash`),
        );
      }
    },
  );

  it.each([
    ['command', { command: 'C:\\digest\\digest.cmd run & calc' }],
    ['command', { command: '"C:\\Program Files\\digest.cmd" run' }],
    ['working directory', { workingDir: 'C:\\R&D\\digest' }],
    ['working directory', { workingDir: 'C:\\100%\\digest' }],
  ])('rejects characters cmd.exe would act on in the Windows %s', (label, overrides) => {
    expect(() => renderOsSchedule('win32', options(overrides))).toThrow(
      new RegExp(`${label}.*cmd\\.exe`),
    );
  });

  it('allows those characters where no cmd.exe is involved', () => {
    const { content } = renderOsSchedule('darwin', options({ workingDir: '/srv/R&D' }));

    expect(content).toContain('/srv/R&amp;D');
  });

  it('tells the user which time zone each OS scheduler uses', () => {
    for (const os of ['darwin', 'linux', 'win32'] as const) {
      expect(renderOsSchedule(os, options()).installHint).toContain('local time zone');
    }
  });

  it('tells Windows users to paste the line into cmd.exe, not PowerShell', () => {
    expect(renderOsSchedule('win32', options()).installHint).toMatch(
      /\(cmd\.exe\), not PowerShell/,
    );
  });

  it('rejects a platform it has no generator for', () => {
    expect(() => renderOsSchedule('freebsd', options())).toThrow(/freebsd/);
    expect(() => renderOsSchedule('freebsd', options())).toThrow(DigestError);
  });
});
