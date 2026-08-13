// @vitest-environment jsdom
/**
 * The session git rail, driven through the FIXTURE seam — deliberately, so
 * this file proves BOTH sides of the seam contract at once: the component's
 * honesty rules, and the fixture's obligation to move state the way the real
 * verbs would (a fixture that cheerfully rolled back over untracked files
 * would let the UI ship a flow the real seam refuses).
 *
 * FLOW A's spine lives here as a component truth: status → checkpoint →
 * status reflects it → rollback → diff honestly empty. The browser-level
 * proof of the same flow is the Playwright journey (e2e/session-git-rail).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EdgeView, EntityId, EntitySummary, SessionGitMergeResult } from '@tm8/contract';
import { createFixtureSeam } from '../data/fixtures/seam-fixture.js';
import { commitFoundation, forge, prTransplant, sessionLive, sessionStale, taskGuideLines } from '../fixtures/index.js';
import type { Seam } from '../data/seam.js';
import { SessionGitBody } from './SessionGitBody.js';

const LIVE = sessionLive.id as EntityId;

function mount(seam: Seam, sessionId: EntityId = LIVE) {
  return render(<SessionGitBody seam={seam} sessionId={sessionId} live={false} />);
}

describe('status header', () => {
  it('shows branch, ahead/behind the base, and the dirty count, from one read', async () => {
    mount(createFixtureSeam());
    await screen.findByTestId('session-git-header');
    expect(screen.getByText('tm8/fixture-lane')).toBeTruthy();
    expect(screen.getByText('↑0')).toBeTruthy();
    expect(screen.getByText('↓1')).toBeTruthy();
    expect(screen.getByText('2 dirty')).toBeTruthy();
    // The dirty files are listed with their porcelain status.
    const files = screen.getByTestId('session-git-files');
    expect(files.textContent).toContain('packages/server/src/facade/handlers/projects.ts');
    expect(files.textContent).toContain('notes/scratch.md');
  });

  it('a session with no worktree renders the NAMED reason, never an empty panel', async () => {
    mount(createFixtureSeam(), sessionStale.id as EntityId);
    const empty = await screen.findByTestId('session-git-unavailable');
    expect(empty.textContent).toContain('no isolated worktree');
    expect(empty.textContent).toContain('workdir mode');
    // No dead action buttons behind an unavailable rail.
    expect(screen.queryByTestId('session-git-actions')).toBeNull();
  });

  it('no worktree hides the VERBS, not the graph: commits and PRs still render below the reason', async () => {
    // Script the graph half: this scratch session recorded a commit and works
    // a task that tracks a PR. The checkout half (gitStatus) still answers
    // no_worktree through the untouched fixture.
    const base = createFixtureSeam();
    const seam: Seam = {
      ...base,
      async connections(id, opts) {
        const mk = (eid: string, type: string, source: EntitySummary, target: EntitySummary): EdgeView => ({
          id: eid, type, source, target, props: {},
          createdBy: forge, createdAt: '2026-08-13T00:00:00Z', updatedAt: '2026-08-13T00:00:00Z',
        });
        const edges: Record<string, EdgeView[]> = {
          [sessionStale.id]: [
            mk('e-ci', 'created_in', commitFoundation, sessionStale),
            mk('e-wo', 'working_on', sessionStale, taskGuideLines),
          ],
          [taskGuideLines.id]: [mk('e-tr', 'tracks', taskGuideLines, prTransplant)],
        };
        const rows = (edges[id] ?? []).filter(
          (e) => !opts?.types || opts.types.length === 0 || opts.types.includes(e.type),
        );
        return { items: rows, nextCursor: null };
      },
    };
    mount(seam, sessionStale.id as EntityId);
    // The reason card is STILL there — the refusal covers the verbs…
    const empty = await screen.findByTestId('session-git-unavailable');
    expect(empty.textContent).toContain('no isolated worktree');
    // …and the graph facts render below it, chips consumed from Lane B.
    const facts = await screen.findByTestId('session-git-facts');
    expect(screen.getByTestId('session-git-commits').textContent).toContain('9b1c2d3e4f');
    expect(facts.contains(screen.getByTestId('linked-pr-chips'))).toBe(true);
    expect(screen.queryByTestId('session-git-actions')).toBeNull();
  });
});

describe('FLOW A spine: checkpoint → rollback → diff reflects it', () => {
  it('checkpoint captures the WIP, moves ahead, and pre-fills the rollback ref', async () => {
    const seam = createFixtureSeam();
    mount(seam);
    fireEvent.click(await screen.findByTestId('session-git-checkpoint'));
    await waitFor(() => {
      expect(screen.getByTestId('session-git-receipt').textContent).toContain('captured 2 file(s)');
    });
    // Status re-read: clean, one ahead.
    await waitFor(() => {
      expect(screen.getByText('clean')).toBeTruthy();
      expect(screen.getByText('↑1')).toBeTruthy();
    });
    const ref = screen.getByTestId('session-git-rollback-ref') as HTMLInputElement;
    expect(ref.value).toMatch(/^[0-9a-f]{40}$/);
    // Checkpoint on the now-clean tree renders DisabledWithReason, not a dead button.
    expect(screen.queryByTestId('session-git-checkpoint')).toBeNull();
    expect(screen.getAllByTestId('disabled-with-reason').length).toBeGreaterThan(0);
  });

  it('rollback takes a two-step confirm and the diff is honestly empty after rolling to base', async () => {
    const seam = createFixtureSeam();
    mount(seam);
    // Checkpoint first so the tree is clean (rollback would refuse untracked).
    fireEvent.click(await screen.findByTestId('session-git-checkpoint'));
    await waitFor(() => expect(screen.getByText('clean')).toBeTruthy());

    const status = await seam.gitStatus(LIVE);
    const base = status.baseOid as string;
    const ref = screen.getByTestId('session-git-rollback-ref') as HTMLInputElement;
    fireEvent.change(ref, { target: { value: base } });
    fireEvent.click(screen.getByTestId('session-git-rollback'));
    // Nothing happened yet — the confirm step is the only path to the verb.
    expect(screen.getByTestId('session-git-rollback-confirm')).toBeTruthy();
    fireEvent.click(screen.getByTestId('session-git-rollback-go'));
    await waitFor(() => {
      expect(screen.getByTestId('session-git-receipt').textContent).toContain('reflog');
    });
    await waitFor(() => expect(screen.getByText('↑0')).toBeTruthy());

    // The diff now tells the truth about a lane that matches its base.
    fireEvent.click(screen.getByTestId('session-git-diff-toggle'));
    await screen.findByTestId('session-git-diff');
    expect(screen.getByTestId('session-git-diff-empty')).toBeTruthy();
  });

  it('the diff digest renders before the text and the fixture diff mounts DiffView', async () => {
    mount(createFixtureSeam());
    await screen.findByTestId('session-git-header');
    fireEvent.click(screen.getByTestId('session-git-diff-toggle'));
    await screen.findByTestId('session-git-diff');
    expect(screen.getByTestId('session-git-diff-digest').textContent).toContain('2 file(s)');
    // DiffView is MOUNTED (the #74 renderer, previously mounted nowhere).
    expect(document.querySelector('.kit-diff')).toBeTruthy();
  });
});

describe('merge honesty', () => {
  it('merge is disabled-with-reason while the worktree is dirty', async () => {
    mount(createFixtureSeam());
    await screen.findByTestId('session-git-header');
    expect(screen.queryByTestId('session-git-merge')).toBeNull();
    const reasons = screen.getAllByTestId('disabled-with-reason');
    expect(reasons.some((r) => r.parentElement?.textContent?.includes('abort to a clean state'))).toBe(true);
  });

  it('merge confirms, then reports merged with the base named', async () => {
    const seam = createFixtureSeam();
    mount(seam);
    fireEvent.click(await screen.findByTestId('session-git-checkpoint'));
    await waitFor(() => expect(screen.getByText('clean')).toBeTruthy());
    fireEvent.click(screen.getByTestId('session-git-merge'));
    // The confirm names the direction and why the other one is absent.
    const confirm = screen.getByTestId('session-git-merge-confirm');
    expect(confirm.textContent).toContain('goes through a PR');
    fireEvent.click(screen.getByTestId('session-git-merge-go'));
    await waitFor(() => {
      expect(screen.getByTestId('session-git-receipt').textContent).toContain('merged main');
    });
    await waitFor(() => expect(screen.getByText('↓0')).toBeTruthy());
  });

  it('a CONFLICT renders the banner with every conflicted path and the clean-restore fact', async () => {
    // A stub seam returning the conflict shape — the fixture's scripted
    // trigger needs a custom fromRef the UI deliberately does not send.
    const fixture = createFixtureSeam();
    const conflictResult: SessionGitMergeResult = {
      sessionId: LIVE, worktreeId: 'fx-worktree-1' as EntityId,
      status: 'conflict', fromRef: 'main', fromOid: 'c'.repeat(40),
      conflictedPaths: ['packages/a.ts', 'packages/b.ts'],
    };
    const seam: Seam = {
      ...fixture,
      gitStatus: async (id) => ({ ...(await fixture.gitStatus(id)), dirty: { staged: 0, unstaged: 0, untracked: 0, total: 0 }, files: [] }),
      commands: { ...fixture.commands, gitMerge: async () => conflictResult },
    };
    mount(seam);
    fireEvent.click(await screen.findByTestId('session-git-merge'));
    fireEvent.click(screen.getByTestId('session-git-merge-go'));
    const banner = await screen.findByTestId('session-git-conflict');
    expect(banner.textContent).toContain('CONFLICTED');
    expect(banner.textContent).toContain('restored clean');
    expect(banner.textContent).toContain('packages/a.ts');
    expect(banner.textContent).toContain('packages/b.ts');
  });
});
