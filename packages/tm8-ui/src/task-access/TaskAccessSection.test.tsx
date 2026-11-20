// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionLaunchRecord } from '@tm8/contract';
import { EntityDetailPanel, type DetailReasons } from '../panels/EntityDetailPanel';
import { REASONS, type ActionContext } from '../domain';
import { FIXTURE_SPACE_ID, presenceHollowReason } from '../fixtures';
import { taskAccessSectionFor } from '../views/taskAccessSection';
import { TaskAccessSection } from './TaskAccessSection';
import { NEXT_TASK, RUN, TASK, record, seamFor, task } from './test-kit';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the unified task access surface', () => {
  it('shows source, policies, account metadata, directories and click-through without secret fields', async () => {
    const h = seamFor(); const open = vi.fn();
    const { container } = render(<TaskAccessSection seam={h.seam} taskId={TASK} onOpenEntity={open} />);
    await screen.findByText('Plan · read only (inherited)');
    expect(screen.getByTestId('task-access-permissions').textContent).toContain('edit details');
    expect(container.textContent).toContain('/worktrees/run');
    expect(container.textContent).toContain('Git a***@example.com');
    expect(container.textContent).toContain('drive.readonly');
    expect(container.textContent).toContain('revoked now');
    expect(container.textContent).toContain('1 connector cannot be shown');
    expect(container.textContent).toContain('Not visible to this viewer');
    for (const secret of ['alice@example.com', 'MANIFEST_SECRET', 'PROMPT_SECRET', 'ENV_SECRET', 'KEY_HINT_SECRET', 'PRIVATE_PASSWORD', 'PRIVATE_QUERY', 'CURRENT_DEFAULT_MUST_NOT_BE_USED']) expect(container.textContent).not.toContain(secret);
    fireEvent.click(screen.getByRole('button', { name: `Run ${RUN}` }));
    expect(open).toHaveBeenCalledWith(RUN);
  });

  it('marks the reading stale on changes and refreshes permissions without retaining old facts', async () => {
    const h = seamFor();
    render(<TaskAccessSection seam={h.seam} taskId={TASK} />);
    await screen.findByText('Plan · read only (inherited)');
    act(() => h.changed());
    expect(screen.getByTestId('task-access-stale')).toBeTruthy();
    h.entity.mockResolvedValue({ ...task(), capabilities: { ...task().capabilities, canEdit: false, canLink: false, canAddChild: false, canComplete: false } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh access' }));
    expect(screen.queryByText('Plan · read only (inherited)')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('task-access-permissions').textContent).toBe('No task changes are allowed for this viewer.'));
    expect(screen.queryByTestId('task-access-stale')).toBeNull();
    expect(h.entity).toHaveBeenCalledTimes(2);
  });

  it('marks readings stale after 60 seconds and cleans up listeners and timers', async () => {
    vi.useFakeTimers();
    const h = seamFor();
    const { unmount } = render(<TaskAccessSection seam={h.seam} taskId={TASK} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId('task-access-permissions')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByTestId('task-access-stale')).toBeTruthy();
    unmount();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores late launches from the previous task when a panel is reused', async () => {
    const h = seamFor();
    let resolveOld!: (value: SessionLaunchRecord) => void;
    h.launch.mockImplementation(() => new Promise((resolve) => { resolveOld = resolve; }));
    const { rerender, container } = render(<TaskAccessSection seam={h.seam} taskId={TASK} />);
    await waitFor(() => expect(h.launch).toHaveBeenCalledOnce());
    rerender(<TaskAccessSection seam={h.seam} taskId={NEXT_TASK} />);
    await screen.findByText('No readable work session is linked to this task.');
    await act(async () => { resolveOld(record()); });
    expect(container.textContent).not.toContain('/worktrees/run');
    expect(container.textContent).not.toContain('Git a***@example.com');
    expect(screen.queryByTestId('task-access-run')).toBeNull();
  });

  it('explains incomplete and missing data instead of showing false empty or access claims', async () => {
    const h = seamFor();
    h.launch.mockRejectedValue(Object.assign(new Error('PRIVATE_ERROR'), { code: 'forbidden' }));
    const { container } = render(<TaskAccessSection seam={h.seam} taskId={TASK} />);
    await screen.findByTestId('task-access-incomplete');
    expect(container.textContent).toContain('Launch record unavailable. Refresh to retry.');
    expect(container.textContent).not.toContain('PRIVATE_ERROR');
    expect(container.textContent).not.toContain('No readable work session');
    expect(container.textContent).not.toContain('Plan · read only');
  });

  it('plainly reports when filesystem sandbox restrictions were not enforced', async () => {
    const h = seamFor();
    const launch = record();
    h.launch.mockResolvedValue(record({ manifest: { ...launch.manifest, launch: { ...(launch.manifest?.launch as object), sandboxDegraded: 'RAW_REASON_MUST_STAY_PRIVATE' } } }));
    const { container } = render(<TaskAccessSection seam={h.seam} taskId={TASK} />);
    await screen.findByText('Filesystem sandbox restrictions were not enforced at launch.');
    expect(container.textContent).not.toContain('RAW_REASON_MUST_STAY_PRIVATE');
  });
});

describe('task panel composition', () => {
  const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
  const reasons: DetailReasons = { presenceHollow: presenceHollowReason,
    versionHistory: REASONS.versionHistoryDeferred, provenanceHollow: 'n/a', shareUnavailable: 'n/a', withdrawUnavailable: 'n/a' };

  it.each(['content', 'connections'] as const)('mounts the same access reading on %s', async (activeTab) => {
    const h = seamFor(); const detail = task();
    render(<EntityDetailPanel detail={detail} reasons={reasons} ctx={ctx} activeTab={activeTab}
      taskGitSection={<div data-testid="git-slot">Git</div>}
      taskAccessSection={taskAccessSectionFor(h.seam, detail)} />);
    await screen.findByText('Plan · read only (inherited)');
    expect(screen.getAllByTestId('task-access-section')).toHaveLength(1);
    if (activeTab === 'content') expect(screen.getByTestId('git-slot')).toBeTruthy();
  });

  it('does not offer an access reading for a missing seam or a tombstone', () => {
    expect(taskAccessSectionFor(undefined, task())).toBeUndefined();
    expect(taskAccessSectionFor(seamFor().seam, { ...task(), deletedAt: '2026-11-21T00:00:00Z' })).toBeUndefined();
  });
});
