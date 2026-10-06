// @vitest-environment jsdom
/**
 * SPEC D1 §5.2 / §5.3 — THE SESSION LIST: its own tab row (Running ·
 * Interrupted · Completed · Stopped), the header count, the Interrupted badge,
 * the groups each tab draws, and the row's visible word, line 2 and process
 * dot. The skill-tabs test's shape, for the kind that now has its own tabs too.
 *
 * The rows are served through a filter that runs the two server axes
 * (`sessionStatus` × `sessionOutcome`) exactly as `collections.query` does, so
 * a tab that asked the wrong question shows the wrong rows here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, within } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter } from '../domain';
import { FIXTURE_SPACE_ID, sessionLive } from '../fixtures';
import { EntityListPanel } from './index';
import { useRunningGrace } from './list/useRunningGrace';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function row(id: string, title: string, state: Record<string, unknown>, parentId: string | null = null): EntitySummary {
  return {
    ...sessionLive,
    id: id as EntitySummary['id'],
    title,
    parentId: parentId as EntitySummary['parentId'],
    state: { ...sessionLive.state, endedKind: null, endedReason: null, ...state } as EntitySummary['state'],
  };
}

const working = row('s-working', 'Working one', { status: 'running' });
const finished = row('s-finished', 'Finished one', { status: 'running', outcome: 'completed', outcomeAt: ago(12 * 60_000), receiptMessageId: 'm1' });
const restart1 = row('s-r1', 'Restart one', { status: 'failed', endedKind: 'server_restart', exitedAt: ago(60_000) });
const restart2 = row('s-r2', 'Restart two', { status: 'failed', endedKind: 'server_restart', exitedAt: ago(60_000) });
const oom = row('s-oom', 'OOM one', { status: 'failed', endedKind: 'out_of_memory', exitedAt: ago(5 * 60_000) });
const completed = row('s-done', 'Completed one', { status: 'exited', endedKind: 'exited_clean', outcome: 'completed', outcomeAt: ago(60_000) });
const stopped = row('s-stopped', 'Stopped one', { status: 'exited', outcome: 'stopped', outcomeBy: 'm-sub', outcomeAt: ago(3 * 3_600_000) });
// §5.3.1 case 7: a running child under a completed parent.
const child = row('s-child', 'Child one', { status: 'running' }, completed.id);

const ALL = [working, finished, restart1, restart2, oom, completed, stopped, child];

function serve(filter: QueryFilter): readonly EntitySummary[] {
  return ALL.filter((r) => {
    const state = r.state as { status: string; outcome?: string };
    if (filter.sessionStatus && !filter.sessionStatus.includes(state.status as never)) return false;
    if (filter.sessionOutcome && !filter.sessionOutcome.includes((state.outcome ?? 'open') as never)) return false;
    return true;
  });
}

function mount(extra: Partial<Parameters<typeof EntityListPanel>[0]> = {}) {
  const asks: QueryFilter[] = [];
  const view = render(
    <EntityListPanel
      kind="work_session"
      rowsFor={(filter) => {
        asks.push(filter);
        return serve(filter);
      }}
      ctx={ctx}
      livenessOf={(id) => (id === finished.id || id === working.id || id === child.id ? 'live' : 'not-running')}
      members={[{ id: 'm-sub', kind: 'member', displayName: 'Subhang' } as never]}
      {...extra}
    />,
  );
  return { ...view, asks };
}

const tabNames = (view: ReturnType<typeof mount>) =>
  view.getAllByRole('tab').map((t) => (t.textContent ?? '').replace(/\d+\+?$/, ''));

beforeEach(() => window.localStorage.clear());

describe('§5.3 the session tab row', () => {
  it('draws Running · Interrupted · Completed · Stopped, opens on Running, and the counts add up', () => {
    const view = mount();
    expect(tabNames(view)).toEqual(['Running', 'Interrupted', 'Completed', 'Stopped']);
    expect(view.getByRole('tab', { selected: true }).textContent).toContain('Running');
    const counts = view.getAllByRole('tab').map((t) => Number((t.textContent ?? '').match(/(\d+)$/)?.[1]));
    expect(counts).toEqual([3, 3, 1, 1]);
    expect(view.getByTestId('kind-total').textContent).toBe(String(ALL.length));
  });

  it('asks the server the outcome × process question for each tab', () => {
    const { asks } = mount();
    expect(asks.some((f) => f.sessionOutcome?.join() === 'open' && f.sessionStatus?.join() === 'exited,failed')).toBe(true);
    expect(asks.some((f) => f.sessionOutcome?.join() === 'stopped' && f.sessionStatus === undefined)).toBe(true);
  });

  it('the header reads "● 3 running" (the Running tab count) and "⚠ 3 interrupted"; Interrupted carries the red badge', () => {
    const view = mount();
    expect(view.getByTestId('list-live-count').textContent).toBe('● 3 running');
    expect(view.getByTestId('list-alert-count').textContent).toBe('⚠ 3 interrupted');
    const interrupted = view.getByRole('tab', { name: /Interrupted/ });
    expect(interrupted.querySelector('[data-alert="true"]')?.textContent).toBe('3');
    expect(view.getByRole('tab', { name: /Completed/ }).querySelector('[data-alert]')).toBeNull();
  });
});

describe('§5.3 Running tab layout', () => {
  it('working rows first, then the divider "Finished, still open (1)" with Stop all finished (scenario 1)', () => {
    const onSessionBulk = vi.fn();
    const view = mount({ onSessionBulk });
    const group = view.getByTestId('session-group');
    expect(group.textContent).toContain('Finished, still open (1)');
    // The finished row comes after the divider.
    const tiles = view.getAllByTestId('list-tile').map((t) => t.getAttribute('data-session-node'));
    expect(tiles.indexOf(finished.id)).toBeGreaterThan(tiles.indexOf(working.id));
    fireEvent.click(within(group).getByTestId('session-group-bulk'));
    expect(onSessionBulk).toHaveBeenCalledWith('stop-all-finished', [finished.id]);
  });

  it('a ✓ row shows its word, "Completed 12m ago · receipt", a grey process dot, a fixed check and Stop (scenario 1, 2)', () => {
    const onSessionVerb = vi.fn();
    const view = mount({ onSessionVerb });
    const tile = view.container.querySelector(`[data-session-node="${finished.id}"]`) as HTMLElement;
    expect(within(tile).getByTestId('session-row-word').textContent).toBe('Finished, still open');
    expect(within(tile).getByTestId('session-row-line2').textContent).toBe('Completed 12m ago · receipt');
    expect(within(tile).getByTestId('session-process-dot').getAttribute('data-dot')).toBe('grey');
    expect(within(tile).getByTestId('session-fixed-check')).toBeTruthy();
    fireEvent.click(tile.querySelector('[data-action="close-process"]')!);
    expect(onSessionVerb).toHaveBeenCalledWith('close-process', finished.id);
  });

  it('case 7: a running child under a completed parent sits at the top level with "↳ under <parent> (Completed)" (scenario 27)', () => {
    const view = mount();
    const tile = view.container.querySelector(`[data-session-node="${child.id}"]`) as HTMLElement;
    expect(within(tile).getByTestId('session-row-crumb').textContent).toBe('↳ under Completed one (Completed)');
  });

  it('the working row says Working with a green dot, and offers Complete and Terminate', () => {
    const view = mount({ onSessionVerb: vi.fn(), onTerminate: vi.fn() });
    const tile = view.container.querySelector(`[data-session-node="${working.id}"]`) as HTMLElement;
    expect(within(tile).getByTestId('session-row-word').textContent).toBe('Working');
    expect(within(tile).getByTestId('session-process-dot').getAttribute('data-dot')).toBe('green');
    const verbs = [...tile.querySelectorAll('[data-action]')].map((b) => b.getAttribute('data-action'));
    expect(verbs).toEqual(expect.arrayContaining(['complete-session', 'terminate']));
  });
});

describe('§5.3 Interrupted tab layout (§5.3.1 cases 4, 5)', () => {
  it('groups by reason — "Server restart (2)" with Resume all — and each row offers Resume, Complete and Dismiss', () => {
    const onSessionBulk = vi.fn();
    const onSessionVerb = vi.fn();
    const view = mount({ onSessionBulk, onSessionVerb, onResume: vi.fn() });
    fireEvent.click(view.getByRole('tab', { name: /Interrupted/ }));
    const groups = view.getAllByTestId('session-group').map((g) => g.textContent ?? '');
    expect(groups[0]).toContain('Server restart (2)');
    expect(groups[1]).toContain('Crashed (1)');
    fireEvent.click(within(view.getAllByTestId('session-group')[0]!).getByTestId('session-group-bulk'));
    expect(onSessionBulk).toHaveBeenCalledWith('resume-all', [restart1.id, restart2.id]);

    const tile = view.container.querySelector(`[data-session-node="${oom.id}"]`) as HTMLElement;
    // Scenario 8: red "Crashed" with its reason on line 2.
    expect(within(tile).getByTestId('session-row-word').textContent).toBe('Crashed');
    expect(within(tile).getByTestId('session-row-line2').textContent).toBe('Crashed 5m ago: out of memory');
    expect(within(tile).getByTestId('session-process-dot').getAttribute('data-dot')).toBe('red');
    const verbs = [...tile.querySelectorAll('[data-action]')].map((b) => b.getAttribute('data-action'));
    expect(verbs).toEqual(expect.arrayContaining(['resume', 'complete-session', 'dismiss-session']));
    fireEvent.click(tile.querySelector('[data-action="dismiss-session"]')!);
    expect(onSessionVerb).toHaveBeenCalledWith('dismiss-session', oom.id);
  });
});

describe('§5.3 Completed and Stopped tabs', () => {
  it('Stopped rows read "Stopped by Subhang 3h ago" and offer Resume only', () => {
    const view = mount({ onResume: vi.fn() });
    fireEvent.click(view.getByRole('tab', { name: /Stopped/ }));
    const tile = view.container.querySelector(`[data-session-node="${stopped.id}"]`) as HTMLElement;
    expect(within(tile).getByTestId('session-row-line2').textContent).toBe('Stopped by Subhang 3h ago');
    const verbs = [...tile.querySelectorAll('[data-action]')].map((b) => b.getAttribute('data-action'));
    expect(verbs).toContain('resume');
    expect(verbs).not.toContain('complete-session');
    expect(within(tile).queryByTestId('session-process-dot')).toBeNull();
  });

  it('Completed rows offer Reopen (resume) and Follow-up (refused with the D4 reason), and a fixed check', () => {
    const view = mount();
    fireEvent.click(view.getByRole('tab', { name: /Completed/ }));
    const tile = view.container.querySelector(`[data-session-node="${completed.id}"]`) as HTMLElement;
    expect(within(tile).getByTestId('session-fixed-check')).toBeTruthy();
    expect(within(tile).getByLabelText('Follow-up')).toBeTruthy();
    // Q2 = B: and Reopen (resume), through the outcome verbs' executor.
    expect(tile.querySelector('[data-action="reopen-session"]') ?? within(tile).queryByLabelText('Reopen (resume)')).toBeTruthy();
  });
});

describe('§5.3.1 case 12 — about 10 s of grace before a row leaves Running', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps a row that left the query for 10 s, then drops it', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const { result, rerender } = renderHook(({ rows }) => useRunningGrace(rows, true), {
      initialProps: { rows: [a, b] as readonly { id: string }[] },
    });
    rerender({ rows: [a] });
    expect(result.current.map((r) => r.id)).toEqual(['a', 'b']);
    act(() => { vi.advanceTimersByTime(9_000); });
    expect(result.current.map((r) => r.id)).toEqual(['a', 'b']);
    act(() => { vi.advanceTimersByTime(1_100); });
    expect(result.current.map((r) => r.id)).toEqual(['a']);
  });

  it('a row that comes back inside the window never visibly left; other tabs pass through', () => {
    const a = { id: 'a' };
    const { result, rerender } = renderHook(({ rows, on }) => useRunningGrace(rows, on), {
      initialProps: { rows: [a] as readonly { id: string }[], on: true },
    });
    rerender({ rows: [], on: true });
    rerender({ rows: [a], on: true });
    expect(result.current.map((r) => r.id)).toEqual(['a']);
    rerender({ rows: [], on: false });
    expect(result.current).toEqual([]);
  });
});
