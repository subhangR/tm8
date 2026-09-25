// The lost-update race behind task 01a0d79e-1b86, reproduced deterministically.
//
// On the live fleet a claude that is BOOTING writes back a `~/.claude.json`
// snapshot it read before tm8 seeded trust, silently dropping the fresh entry
// (measured: 8 of 40 planted entries lost within 0.4–7.7s while other claudes
// started). Here that stale writer is simulated at the one moment it hurts —
// right after tm8's own rename — by wrapping `rename`, so the test does not
// depend on timing. Every config lives in a temp HOME.

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type StaleWriter = (configPath: string) => Promise<void>;
const hook: { afterRename: StaleWriter | null } = { afterRename: null };

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await actual.rename(from, to);
      if (to.endsWith('.claude.json') && hook.afterRename) await hook.afterRename(to);
    },
  };
});

const { trustClaudeWorkspace } = await import('../src/spawn/workspace-trust.js');

async function sandbox(): Promise<{ home: string; workspace: string; configPath: string }> {
  const home = await mkdtemp(join(tmpdir(), 'tm8-trust-race-'));
  const workspace = join(home, 'worktrees', 'project', 'lane');
  await mkdir(workspace, { recursive: true });
  return { home, workspace, configPath: join(home, '.claude.json') };
}

/** A booting claude: it read the config BEFORE tm8's write and now writes that
 *  snapshot back, `times` times. Returns how many clobbers really removed an entry. */
function staleWriter(snapshot: string, times: number): { clobbers: () => number } {
  let left = times;
  let effective = 0;
  hook.afterRename = async (configPath) => {
    if (left <= 0) return;
    left -= 1;
    const before = await readFile(configPath, 'utf8');
    await writeFile(configPath, snapshot);
    if (before !== snapshot) effective += 1;
  };
  return { clobbers: () => effective };
}

const trusted = async (configPath: string, path: string): Promise<boolean> => {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  return config.projects?.[path]?.hasTrustDialogAccepted === true;
};

afterEach(() => {
  hook.afterRename = null;
});

describe('trustClaudeWorkspace — re-assert against a stale concurrent writer', () => {
  it('re-reads after writing and restores an entry a stale writer dropped', async () => {
    const { home, workspace, configPath } = await sandbox();
    const snapshot = JSON.stringify({ projects: { '/someone/else': { hasTrustDialogAccepted: true } } });
    await writeFile(configPath, snapshot);
    const stale = staleWriter(snapshot, 1);

    const outcome = await trustClaudeWorkspace(workspace, { HOME: home });

    // Control: the simulated writer really did remove tm8's first write, so
    // the pass below is the re-assert's doing and not a no-op clobber.
    expect(stale.clobbers()).toBe(1);
    expect(outcome).toBe('trusted');
    const keys = Object.keys(JSON.parse(await readFile(configPath, 'utf8')).projects);
    const lane = keys.find((k) => k.endsWith(join('project', 'lane')))!;
    expect(await trusted(configPath, lane)).toBe(true);
    // The unrelated row the stale snapshot carried is still there.
    expect(await trusted(configPath, '/someone/else')).toBe(true);
  });

  it('reports `unverified` — never `trusted` — when every write is clobbered', async () => {
    // The negative control: a writer that wins every round. The function must
    // neither loop forever nor claim success; the launch then relies on the
    // PTY watchdog, which is what `unverified` tells SpawnService.
    const { home, workspace, configPath } = await sandbox();
    const snapshot = JSON.stringify({ projects: {} });
    await writeFile(configPath, snapshot);
    const stale = staleWriter(snapshot, Number.POSITIVE_INFINITY);

    expect(await trustClaudeWorkspace(workspace, { HOME: home })).toBe('unverified');
    expect(stale.clobbers()).toBe(3);
  });

  it('writes the stable trust root too, and re-asserts both', async () => {
    const { home, workspace, configPath } = await sandbox();
    const root = join(home, 'worktrees', 'project');
    const snapshot = JSON.stringify({ projects: {} });
    await writeFile(configPath, snapshot);
    staleWriter(snapshot, 1);

    expect(await trustClaudeWorkspace(workspace, { HOME: home }, { trustRoot: root })).toBe('trusted');
    const keys = Object.keys(JSON.parse(await readFile(configPath, 'utf8')).projects);
    expect(keys.filter((k) => k.endsWith(join('worktrees', 'project')))).toHaveLength(1);
    expect(keys.filter((k) => k.endsWith(join('project', 'lane')))).toHaveLength(1);
  });

  it('once the root is in the file, a clobbered leaf still leaves the lane covered', async () => {
    // Why the trust root is PREVENTION: a stale writer's snapshot predates
    // only the entries written after it read. The root was written by an
    // earlier lane, so it is in that snapshot and survives the clobber that
    // drops the new leaf — and Claude consults it for the lane (measured on
    // 2.1.280: the parent of a scratch dir, the main repo of a worktree).
    const { home, workspace, configPath } = await sandbox();
    const root = join(home, 'worktrees', 'project');
    const earlier = join(root, 'earlier-lane');
    await mkdir(earlier, { recursive: true });
    await trustClaudeWorkspace(earlier, { HOME: home }, { trustRoot: root });
    const snapshotWithRoot = await readFile(configPath, 'utf8');
    staleWriter(snapshotWithRoot, Number.POSITIVE_INFINITY);

    await trustClaudeWorkspace(workspace, { HOME: home }, { trustRoot: root });

    const projects = JSON.parse(await readFile(configPath, 'utf8')).projects as Record<string, unknown>;
    const rootKey = Object.keys(projects).find((k) => k.endsWith(join('worktrees', 'project')))!;
    const leafKey = Object.keys(projects).find((k) => k.endsWith(join('project', 'lane')));
    expect(leafKey).toBeUndefined(); // the leaf lost every round…
    expect(await trusted(configPath, rootKey)).toBe(true); // …and the root never moved
  });
});
