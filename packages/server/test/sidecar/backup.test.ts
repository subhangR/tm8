/**
 * Backup naming, retention and weekly promotion — SIDECAR-PACKAGING.md §5.
 *
 * Retention is the only place in the sidecar that deletes anything, so it gets
 * asserted twice over: it keeps exactly the newest N, and it never touches
 * `pre-migration/`.
 */

import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DAILY_RETENTION,
  WEEKLY_RETENTION,
  backupDirs,
  ensureBackupDirs,
  isoWeekKey,
  promoteWeekly,
  pruneTier,
  utcStamp,
} from '../../src/sidecar/backup.js';
import { silentLogger } from '../../src/sidecar/log.js';

const scratch: string[] = [];
function tempDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tm8-backup-'));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

describe('stamps', () => {
  it('produces a lexically sortable UTC stamp', () => {
    expect(utcStamp(new Date('2026-07-25T14:03:22.123Z'))).toBe('20260725T140322Z');
    const early = utcStamp(new Date('2026-01-01T00:00:00Z'));
    const late = utcStamp(new Date('2026-12-31T23:59:59Z'));
    expect([late, early].sort()).toEqual([early, late]);
  });

  it('computes ISO week keys, including the year-boundary case', () => {
    expect(isoWeekKey(new Date('2026-07-25T00:00:00Z'))).toBe('2026-W30');
    // 2027-01-01 is a Friday → ISO week 53 of 2026.
    expect(isoWeekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
  });
});

describe('retention', () => {
  it('keeps the newest N daily dumps and removes the rest', async () => {
    const dataDir = tempDataDir();
    const dirs = await ensureBackupDirs({ backupsDir: join(dataDir, 'backups') });

    const stamps = Array.from({ length: 10 }, (_, i) =>
      utcStamp(new Date(Date.UTC(2026, 6, 10 + i, 3, 0, 0))),
    );
    for (const s of stamps) writeFileSync(join(dirs.daily, `tm8_${s}.dump`), 'x');

    const removed = await pruneTier(dirs.daily, DAILY_RETENTION, silentLogger);

    expect(removed).toHaveLength(3);
    const kept = readdirSync(dirs.daily).sort();
    expect(kept).toHaveLength(DAILY_RETENTION);
    // The newest 7 survive; the oldest 3 are gone.
    expect(kept[0]).toBe(`tm8_${stamps[3]}.dump`);
    expect(kept[kept.length - 1]).toBe(`tm8_${stamps[9]}.dump`);
  });

  it('is a no-op below the threshold and on a missing directory', async () => {
    const dataDir = tempDataDir();
    const dirs = backupDirs({ backupsDir: join(dataDir, 'backups') });
    expect(await pruneTier(dirs.daily, DAILY_RETENTION, silentLogger)).toEqual([]);

    mkdirSync(dirs.weekly, { recursive: true });
    writeFileSync(join(dirs.weekly, 'tm8_2026-W30_20260725T000000Z.dump'), 'x');
    expect(await pruneTier(dirs.weekly, WEEKLY_RETENTION, silentLogger)).toEqual([]);
  });

  it('ignores non-dump files', async () => {
    const dataDir = tempDataDir();
    const dirs = await ensureBackupDirs({ backupsDir: join(dataDir, 'backups') });
    writeFileSync(join(dirs.daily, 'README.txt'), 'x');
    for (let i = 0; i < 9; i++) {
      writeFileSync(join(dirs.daily, `tm8_2026071${i}T000000Z.dump`), 'x');
    }
    await pruneTier(dirs.daily, DAILY_RETENTION, silentLogger);
    expect(readdirSync(dirs.daily)).toContain('README.txt');
    expect(readdirSync(dirs.daily).filter((n) => n.endsWith('.dump'))).toHaveLength(DAILY_RETENTION);
  });
});

describe('weekly promotion', () => {
  it('promotes the first daily of an ISO week and skips later ones', async () => {
    const dataDir = tempDataDir();
    const dirs = await ensureBackupDirs({ backupsDir: join(dataDir, 'backups') });
    const monday = new Date('2026-07-20T03:00:00Z');
    const tuesday = new Date('2026-07-21T03:00:00Z');

    const daily = join(dirs.daily, `tm8_${utcStamp(monday)}.dump`);
    writeFileSync(daily, 'dump-bytes');

    const first = await promoteWeekly(dirs, daily, monday, silentLogger);
    expect(first).not.toBeNull();
    expect(readdirSync(dirs.weekly)).toHaveLength(1);

    const second = await promoteWeekly(dirs, daily, tuesday, silentLogger);
    expect(second).toBeNull();
    expect(readdirSync(dirs.weekly)).toHaveLength(1);

    // The next ISO week promotes again.
    const nextWeek = new Date('2026-07-27T03:00:00Z');
    expect(await promoteWeekly(dirs, daily, nextWeek, silentLogger)).not.toBeNull();
    expect(readdirSync(dirs.weekly)).toHaveLength(2);
  });
});

describe('pre-migration exemption', () => {
  it('never prunes pre-migration dumps — they are the §4 recovery artifact', async () => {
    const dataDir = tempDataDir();
    const dirs = await ensureBackupDirs({ backupsDir: join(dataDir, 'backups') });
    for (let i = 0; i < 20; i++) {
      const stamp = utcStamp(new Date(Date.UTC(2026, 6, 1, 0, i, 0)));
      writeFileSync(join(dirs.preMigration, `premigrate_17-18_${stamp}.dump`), 'x');
    }
    // The daily sweep touches daily/ and weekly/ only.
    await pruneTier(dirs.daily, DAILY_RETENTION, silentLogger);
    await pruneTier(dirs.weekly, WEEKLY_RETENTION, silentLogger);
    expect(readdirSync(dirs.preMigration)).toHaveLength(20);
  });
});
