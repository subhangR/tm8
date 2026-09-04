// @vitest-environment jsdom
/**
 * Tier 2 COMPLETION on the session git rail — cherry-pick, branch ops,
 * stash — through the FIXTURE seam, proving both sides at once: the rail's
 * honesty rules (disabled-with-reason, spelled-out direction, two-step
 * inline confirms, conflict banners that say the worktree was restored
 * clean) and the fixture's obligation to HONOUR its arguments the way the
 * real verbs would.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { createFixtureSeam } from '../data/fixtures/seam-fixture.js';
import { sessionLive } from '../fixtures/index.js';
import type { Seam } from '../data/seam.js';
import { SessionGitBody } from './SessionGitBody.js';

const LIVE = sessionLive.id as EntityId;

function mount(seam: Seam) {
  return render(<SessionGitBody seam={seam} sessionId={LIVE} live={false} />);
}

/** The fixture lane starts dirty; sweep it so the clean-tree verbs open up. */
async function checkpointClean() {
  fireEvent.click(await screen.findByTestId('session-git-checkpoint'));
  await waitFor(() => {
    expect(screen.getByTestId('session-git-receipt').textContent).toContain('captured');
  });
}

describe('cherry-pick', () => {
  it('is disabled with the dirty-tree reason until the lane is clean', async () => {
    mount(createFixtureSeam());
    const group = await screen.findByTestId('session-git-cherry-group');
    expect(group.textContent).toContain('Cherry-pick refuses while the worktree is dirty');
  });

  it('spells the direction out in words before the click, then applies', async () => {
    mount(createFixtureSeam());
    await checkpointClean();
    fireEvent.change(screen.getByTestId('session-git-cherry-refs'), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByTestId('session-git-cherry'));
    const confirm = await screen.findByTestId('session-git-cherry-confirm');
    // Direction, in words: which commits, ONTO which branch.
    expect(confirm.textContent).toContain('abc123');
    expect(confirm.textContent).toContain('ONTO tm8/fixture-lane');
    fireEvent.click(screen.getByTestId('session-git-cherry-go'));
    await waitFor(() => {
      expect(screen.getByTestId('session-git-receipt').textContent).toContain('picked 1 commit(s) onto tm8/fixture-lane');
    });
  });

  it('a conflict is a banner naming the paths AND the restored-clean fact', async () => {
    mount(createFixtureSeam());
    await checkpointClean();
    fireEvent.change(screen.getByTestId('session-git-cherry-refs'), { target: { value: 'conflict/pick' } });
    fireEvent.click(screen.getByTestId('session-git-cherry'));
    fireEvent.click(await screen.findByTestId('session-git-cherry-go'));
    const banner = await screen.findByTestId('session-git-conflict');
    expect(banner.textContent).toContain('CONFLICTED');
    expect(banner.textContent).toContain('restored clean');
    expect(banner.textContent).toContain('packages/server/src/facade/handlers/projects.ts');
  });
});

describe('branch ops', () => {
  it('create is disabled without a name, then creates without checking out', async () => {
    mount(createFixtureSeam());
    const group = await screen.findByTestId('session-git-branch-group');
    expect(group.textContent).toContain('Creating a branch needs a name.');
    fireEvent.change(screen.getByTestId('session-git-branch-name'), { target: { value: 'feat/spike' } });
    fireEvent.click(screen.getByTestId('session-git-branch-create'));
    await waitFor(() => {
      expect(screen.getByTestId('session-git-receipt').textContent).toContain('created feat/spike');
      expect(screen.getByTestId('session-git-receipt').textContent).toContain('not checked out anywhere');
    });
  });

  it('delete takes a two-step INLINE confirm that names the unmerged measurement', async () => {
    mount(createFixtureSeam());
    await screen.findByTestId('session-git-branch-group');
    fireEvent.change(screen.getByTestId('session-git-branch-delete-name'), { target: { value: 'main' } });
    fireEvent.click(screen.getByTestId('session-git-branch-delete'));
    const confirm = await screen.findByTestId('session-git-branch-delete-confirm');
    expect(confirm.textContent).toContain('measured against tm8/fixture-lane');
    expect(confirm.textContent).toContain('reachable by its oid until gc');
    // The PROTECTED/checked-out refusal comes back as the action error.
    fireEvent.click(screen.getByTestId('session-git-branch-delete-go'));
    await waitFor(() => {
      expect(screen.getByTestId('session-git-action-error').textContent).toContain('protected branch');
    });
  });

  it('an unmerged delete refuses without force and succeeds with it', async () => {
    const seam = createFixtureSeam();
    mount(seam);
    await screen.findByTestId('session-git-branch-group');
    // Create the fixture's scripted unmerged branch, then try deleting it.
    fireEvent.change(screen.getByTestId('session-git-branch-name'), { target: { value: 'unmerged/spike' } });
    fireEvent.click(screen.getByTestId('session-git-branch-create'));
    await waitFor(() => {
      expect(screen.getByTestId('session-git-receipt').textContent).toContain('created unmerged/spike');
    });
    fireEvent.change(screen.getByTestId('session-git-branch-delete-name'), { target: { value: 'unmerged/spike' } });
    fireEvent.click(screen.getByTestId('session-git-branch-delete'));
    fireEvent.click(await screen.findByTestId('session-git-branch-delete-go'));
    await waitFor(() => {
      expect(screen.getByTestId('session-git-action-error').textContent).toContain('not merged into');
    });
    // Same confirm, force ticked: the delete lands and the receipt carries the oid.
    fireEvent.click(screen.getByTestId('session-git-branch-delete'));
    fireEvent.click(await screen.findByTestId('session-git-branch-delete-force'));
    fireEvent.click(screen.getByTestId('session-git-branch-delete-go'));
    await waitFor(() => {
      const receipt = screen.getByTestId('session-git-receipt').textContent ?? '';
      expect(receipt).toContain('deleted unmerged/spike');
      expect(receipt).toContain('unmerged relative to tm8/fixture-lane');
    });
  });
});

describe('stash', () => {
  it('push sweeps the dirty lane into an entry the list then shows', async () => {
    mount(createFixtureSeam());
    fireEvent.click(await screen.findByTestId('session-git-stash-push'));
    await waitFor(() => {
      const receipt = screen.getByTestId('session-git-receipt').textContent ?? '';
      expect(receipt).toContain('stashed 2 file(s)');
      expect(receipt).toContain('stored, not lost');
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-git-stash-list').textContent).toContain('stash@{0}');
    });
    // The lane is clean now, so Stash WIP goes disabled WITH its reason.
    expect(screen.getByTestId('session-git-stash-group').textContent)
      .toContain('nothing to stash');
  });

  it('pop restores the entry and removes it from the list', async () => {
    mount(createFixtureSeam());
    fireEvent.click(await screen.findByTestId('session-git-stash-push'));
    await waitFor(() => screen.getByTestId('session-git-stash-list'));
    fireEvent.click(screen.getByTestId('session-git-stash-pop-0'));
    await waitFor(() => {
      expect(screen.getByTestId('session-git-receipt').textContent).toContain('2 file(s) back in the worktree');
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-git-stash-empty')).toBeTruthy();
    });
  });

  it('drop is a two-step inline confirm that names the destruction and the gc window', async () => {
    mount(createFixtureSeam());
    fireEvent.click(await screen.findByTestId('session-git-stash-push'));
    await waitFor(() => screen.getByTestId('session-git-stash-list'));
    fireEvent.click(screen.getByTestId('session-git-stash-drop-0'));
    const confirm = await screen.findByTestId('session-git-stash-drop-confirm-0');
    expect(confirm.textContent).toContain('DESTROYS');
    expect(confirm.textContent).toContain('until gc');
    fireEvent.click(screen.getByTestId('session-git-stash-drop-go-0'));
    await waitFor(() => {
      expect(screen.getByTestId('session-git-receipt').textContent).toContain('until gc');
      expect(screen.getByTestId('session-git-stash-empty')).toBeTruthy();
    });
  });

  it('a conflicted pop banners the paths, the restored-clean fact, AND that the entry was retained', async () => {
    const seam = createFixtureSeam();
    // Seed the scripted conflict BEFORE mounting: the fixture's pop conflicts
    // when the entry's subject contains 'conflict' (its 'conflict/base' idea).
    await seam.commands.gitStash(LIVE, { action: 'push', message: 'conflict wip' });
    mount(seam);
    await screen.findByTestId('session-git-stash-list');
    fireEvent.click(screen.getByTestId('session-git-stash-pop-0'));
    const banner = await screen.findByTestId('session-git-conflict');
    expect(banner.textContent).toContain('CONFLICTED');
    expect(banner.textContent).toContain('restored clean');
    expect(banner.textContent).toContain('RETAINED');
    expect(banner.textContent).toContain('packages/server/src/facade/handlers/projects.ts');
    // Retained means the list still shows it.
    expect(screen.getByTestId('session-git-stash-list').textContent).toContain('stash@{0}');
  });
});
