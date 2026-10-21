import { describe, expect, it } from 'vitest';

import {
  classifyCheckout, DAY, defaultRetentionRules, diskLevel, HOUR, pinnedPaths, planRetention, planScratchDir,
  POINTER_FILE, shouldAlert, type CheckoutFacts, type InventoryEntry, type RetentionInventory,
} from '../../src/ops/disk-retention.js';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const entry = (dir: string, name: string, ageMs: number, extra: Partial<InventoryEntry> = {}): InventoryEntry =>
  ({ path: `${dir}/${name}`, name, isDir: true, mtimeMs: NOW - ageMs, ...extra });
const inventory = (dirs: Record<string, InventoryEntry[]>, more: Partial<RetentionInventory> = {}): RetentionInventory =>
  ({ dirs: new Map(Object.entries(dirs)), sizes: new Map(), pinned: new Set(), liveCwds: [], ...more });
const layout = { deployRoot: '/opt/tm8', dataDir: '/data', home: '/home/tm8', systemTmp: '/tmp' };
const rules = defaultRetentionRules(layout);
const deleted = (inv: RetentionInventory) => planRetention(rules, inv, NOW).delete.map((d) => d.path).sort();

describe('deploy leftovers', () => {
  it('keeps the newest two prod-prev builds and removes older ones once a day old', () => {
    const builds = ['20260822T071301Z', '20260905T061201Z', '20260915T174501Z', '20261014T202401Z']
      .map((ts, i) => entry('/opt/tm8', `prod-prev.${ts}`, (40 - i * 10) * DAY));
    expect(deleted(inventory({ '/opt/tm8': [...builds, entry('/opt/tm8', 'prod', 0), entry('/opt/tm8', 'staging', 90 * DAY)] })))
      .toEqual(['/opt/tm8/prod-prev.20260822T071301Z', '/opt/tm8/prod-prev.20260905T061201Z']);
  });

  it('orders by the UTC stamp in the name, not by mtime, which mv preserves', () => {
    // Measured on the host: by mtime the 0905 build looked newer than 0915 and 0917.
    const mtimeDays: Record<string, number> = { '20260822T071301Z': 59, '20260905T061201Z': 6,
      '20260915T174501Z': 35, '20260917T170401Z': 33, '20261014T202401Z': 6 };
    const builds = Object.entries(mtimeDays).map(([ts, d]) => entry('/opt/tm8', `prod-prev.${ts}`, d * DAY));
    expect(deleted(inventory({ '/opt/tm8': builds }))).toEqual([
      '/opt/tm8/prod-prev.20260822T071301Z', '/opt/tm8/prod-prev.20260905T061201Z', '/opt/tm8/prod-prev.20260915T174501Z']);
  });

  it('never keeps a DB dump in candidates past three days, and keeps the newest four other candidates', () => {
    const dir = '/opt/tm8/candidates';
    const inv = inventory({ [dir]: [
      entry(dir, 'tm8_prod_before_0bca1069_20261005T075901Z.dump', 15 * DAY, { isDir: false }),
      entry(dir, 'fresh.dump', 1 * DAY, { isDir: false }),
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => entry(dir, `ui-main-${n}`, (10 + i) * DAY)),
    ] });
    expect(deleted(inv)).toEqual([`${dir}/tm8_prod_before_0bca1069_20261005T075901Z.dump`, `${dir}/ui-main-e`, `${dir}/ui-main-f`]);
  });

  it('does not count young entries against the keep budget into deletion', () => {
    const dir = '/opt/tm8/candidates';
    const inv = inventory({ [dir]: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => entry(dir, `c-${n}`, 1 * DAY)) });
    expect(deleted(inv)).toEqual([]);
  });

  it('keeps what a LAST_* pointer names, whatever its age', () => {
    const dir = '/opt/tm8/deploy-backups';
    const dumps = [1, 2, 3, 4, 5].map((n) => entry(dir, `tm8_prod_before_${n}.dump`, n * 10 * DAY, { isDir: false }));
    const plan = planRetention(rules, inventory({ [dir]: dumps }, { pinned: new Set([`${dir}/tm8_prod_before_5.dump`]) }), NOW);
    expect(plan.delete.map((d) => d.path)).toEqual([`${dir}/tm8_prod_before_4.dump`]);
    expect(plan.kept).toEqual([expect.objectContaining({ path: `${dir}/tm8_prod_before_5.dump` })]);
  });

  it('reads pointer files for absolute paths only', () => {
    expect(POINTER_FILE.test('LAST_BACKUP')).toBe(true);
    expect(POINTER_FILE.test('UI_ROLLBACK_TREE')).toBe(true);
    expect(POINTER_FILE.test('restart-prod.sh')).toBe(false);
    expect(pinnedPaths('/opt/tm8/deploy-backups/x.dump\n')).toEqual(['/opt/tm8/deploy-backups/x.dump']);
    expect(pinnedPaths('8f3c2a1 main')).toEqual([]);
  });

  it('has no deploy, cache or /tmp rules on a server that does not own the shared paths', () => {
    const own = defaultRetentionRules({ deployRoot: null, dataDir: '/data', home: null, systemTmp: null });
    expect(own.every((r) => (r.kind === 'size_cap' ? r.path : r.dir).startsWith('/data/'))).toBe(true);
  });
});

describe('temp output and caches', () => {
  it('expires Vitest module dumps after 6h and leaves other 21-char dirs alone', () => {
    const inv = inventory({ '/tmp': [
      entry('/tmp', 'Z_ZDbI0uPtlv-n_CnSuaD', 7 * HOUR, { children: ['client', 'ssr'] }),
      entry('/tmp', 'Dr4pDv2qLHhe-pETOe-7Q', 1 * HOUR, { children: ['client'] }),
      entry('/tmp', 'abcdefghijklmnopqrstu', 30 * DAY, { children: ['client', 'notes.txt'] }),
      entry('/tmp', 'tm8-smoke-abc123-x', 3 * DAY),
      entry('/tmp', 'systemd-private-xyz', 30 * DAY),
    ] });
    expect(deleted(inv)).toEqual(['/tmp/Z_ZDbI0uPtlv-n_CnSuaD', '/tmp/tm8-smoke-abc123-x']);
  });

  it('expires anything in the managed session TMPDIR after two days', () => {
    const inv = inventory({ '/data/tmp': [entry('/data/tmp', 'claude-110', 3 * DAY), entry('/data/tmp', 'build-out', 1 * DAY)] });
    expect(deleted(inv)).toEqual(['/data/tmp/claude-110']);
  });

  it('wipes a cache only when it is over its cap, and never on an unmeasured size', () => {
    const sizes = new Map([['/home/tm8/.npm/_cacache', 2 * 1024 ** 3], ['/home/tm8/.cache/pnpm', 100 * 1024 ** 2]]);
    expect(deleted(inventory({}, { sizes }))).toEqual(['/home/tm8/.npm/_cacache']);
  });

  it('never deletes where a running process has its cwd', () => {
    const inv = inventory({ '/data/tmp': [entry('/data/tmp', 'busy', 9 * DAY)] }, { liveCwds: ['/data/tmp/busy/sub'] });
    const plan = planRetention(rules, inv, NOW);
    expect(plan.delete).toEqual([]);
    expect(plan.kept[0]).toMatchObject({ path: '/data/tmp/busy', reason: 'a running process has its cwd here' });
  });
});

describe('checkouts', () => {
  const facts = (over: Partial<CheckoutFacts>): CheckoutFacts => ({
    path: '/data/worktrees/p/w', session: 'ended', endedForMs: 2 * DAY, idleMs: 2 * DAY, dirty: false, unpushed: 0, ...over,
  });

  it('removes the checkout of an ended session once clean and pushed', () => {
    expect(classifyCheckout(facts({}), [])).toEqual({ action: 'remove', reason: 'session ended; clean and pushed' });
  });

  it('keeps and flags unpushed or uncommitted work', () => {
    expect(classifyCheckout(facts({ unpushed: 3 }), [])).toEqual({ action: 'flag', reason: '3 commits on no remote' });
    expect(classifyCheckout(facts({ dirty: true }), [])).toEqual({ action: 'flag', reason: 'uncommitted changes' });
    expect(classifyCheckout(facts({ probeFailed: 'no remote configured' }), []).action).toBe('flag');
  });

  it('keeps a live session, a recent end, and an in-use checkout', () => {
    expect(classifyCheckout(facts({ session: 'live', endedForMs: null }), []).action).toBe('keep');
    expect(classifyCheckout(facts({ endedForMs: 1 * HOUR }), []).action).toBe('keep');
    expect(classifyCheckout(facts({ idleMs: 1 * HOUR }), []).action).toBe('keep');
    expect(classifyCheckout(facts({}), ['/data/worktrees/p/w']).action).toBe('keep');
  });

  it('waits a week of idleness before considering a checkout with no known session', () => {
    expect(classifyCheckout(facts({ session: 'unknown', endedForMs: null, idleMs: 6 * DAY }), []).action).toBe('keep');
    expect(classifyCheckout(facts({ session: 'unknown', endedForMs: null, idleMs: 8 * DAY }), []))
      .toEqual({ action: 'remove', reason: 'no session, idle, clean and pushed' });
    expect(classifyCheckout(facts({ session: 'unknown', endedForMs: null, idleMs: 8 * DAY, unpushed: 1 }), []).action).toBe('flag');
  });
});

describe('scratch dirs', () => {
  const base = { path: '/data/scratch/s1', session: 'ended' as const, endedForMs: 2 * DAY, idleMs: 2 * DAY, nestedRegenerable: [] };
  const removable = { action: 'remove' as const, reason: 'session ended; clean and pushed' };

  it('removes the whole dir when every checkout is clean and pushed and nothing else is in it', () => {
    const plan = planScratchDir({ ...base, children: [
      { path: '/data/scratch/s1/wt', kind: 'checkout', decision: removable },
      { path: '/data/scratch/s1/node_modules', kind: 'regenerable' },
      { path: '/data/scratch/s1/graphify-out', kind: 'symlink' },
    ] }, []);
    expect(plan.delete.map((d) => d.path)).toEqual(['/data/scratch/s1']);
  });

  it('keeps a dir holding unpushed work, flags it, and still drops what is regenerable', () => {
    const plan = planScratchDir({ ...base, nestedRegenerable: ['/data/scratch/s1/wt/node_modules'], children: [
      { path: '/data/scratch/s1/wt', kind: 'checkout', decision: { action: 'flag', reason: '2 commits on no remote' } },
      { path: '/data/scratch/s1/clean', kind: 'checkout', decision: removable },
      { path: '/data/scratch/s1/node_modules', kind: 'regenerable' },
    ] }, []);
    expect(plan.flagged).toEqual([{ path: '/data/scratch/s1/wt', rule: 'scratch', reason: '2 commits on no remote' }]);
    expect(plan.delete.map((d) => d.path).sort())
      .toEqual(['/data/scratch/s1/clean', '/data/scratch/s1/node_modules', '/data/scratch/s1/wt/node_modules']);
  });

  it('keeps loose files for 30 days after the session, then removes the dir', () => {
    const children = [{ path: '/data/scratch/s1/notes.md', kind: 'other' as const }];
    expect(planScratchDir({ ...base, children }, []).delete).toEqual([]);
    expect(planScratchDir({ ...base, idleMs: 31 * DAY, endedForMs: 31 * DAY, children }, []).delete.map((d) => d.path))
      .toEqual(['/data/scratch/s1']);
  });

  it('leaves a live session and an in-use dir alone', () => {
    expect(planScratchDir({ ...base, session: 'live', endedForMs: null, children: [] }, []).delete).toEqual([]);
    expect(planScratchDir({ ...base, children: [] }, ['/data/scratch/s1/wt']).delete).toEqual([]);
  });
});

describe('disk alert', () => {
  it('warns from 85% and is critical from 92%', () => {
    expect(diskLevel(84.9)).toBe('ok');
    expect(diskLevel(85)).toBe('warn');
    expect(diskLevel(93)).toBe('critical');
  });

  it('alerts on every rise, on recovery, and every 6h while high, not every tick', () => {
    expect(shouldAlert({ level: 'ok', sentAt: null }, 'warn', NOW)).toBe(true);
    expect(shouldAlert({ level: 'warn', sentAt: NOW - HOUR }, 'warn', NOW)).toBe(false);
    expect(shouldAlert({ level: 'warn', sentAt: NOW - 7 * HOUR }, 'warn', NOW)).toBe(true);
    expect(shouldAlert({ level: 'warn', sentAt: NOW - HOUR }, 'critical', NOW)).toBe(true);
    expect(shouldAlert({ level: 'critical', sentAt: NOW - HOUR }, 'ok', NOW)).toBe(true);
    expect(shouldAlert({ level: 'ok', sentAt: NOW - HOUR }, 'ok', NOW)).toBe(false);
  });
});
