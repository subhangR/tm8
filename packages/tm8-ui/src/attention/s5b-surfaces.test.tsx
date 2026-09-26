// @vitest-environment jsdom
/**
 * Attention v2 · S5b surfaces against a hand-written `AttentionApi` (no seam):
 * the detail block (tab 3), the session banner and tile lines (tab 4, F1), the
 * roll-up line (tab 5), the phone button (tab 7) and "Needs me" as the queue
 * (tab 8).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionRequest, EntityId, EntitySummary } from '@tm8/contract';
import { AttentionApiProvider, type AttentionApi, type AttentionChip, type AttentionQueueRow } from './index';
import { AttentionBlock } from './AttentionBlock';
import { SessionWaitingBanner } from './SessionWaitingBanner';
import { AttentionTileSubtitle } from './AttentionTileSubtitle';
import { AttentionHeaderButton } from './AttentionSheet';
import { LegacyAttentionDock } from './LegacyAttentionDock';
import { needsMeListSource } from './needs-me';
import { rollupLine, sessionWaitingLine, shortSessionId } from './attention-subtitles';

const TASK = '01a0dd99-0000-7000-8000-00000000a0a1' as EntityId;
const SESSION = '01a0dd99-0000-7000-8000-00000000a41f' as EntityId;
const SESSION_2 = '01a0dd99-0000-7000-8000-00000000c09e' as EntityId;
const HOUR = 3600_000;

function request(over: Partial<AttentionRequest> & { id: string }): AttentionRequest {
  return {
    spaceId: 'space' as AttentionRequest['spaceId'],
    entityId: TASK,
    reason: 'Pick retry policy: 3× fixed or exponential up to 1h?',
    points: 60,
    status: 'open',
    version: 1,
    requestedBy: { id: 'agent', displayName: 'Payments Guy', isAgent: true } as AttentionRequest['requestedBy'],
    acknowledgedBy: null,
    resolvedBy: null,
    resolutionNote: null,
    createdAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    updatedAt: new Date().toISOString(),
    acknowledgedAt: null,
    resolvedAt: null,
    rootId: TASK,
    level: 'high',
    actionType: 'decide',
    sourceWorkSessionId: SESSION,
    sourceSessionLive: true,
    origin: 'agent',
    seenByMe: false,
    ...over,
  };
}

const chip = (over: Partial<AttentionChip> = {}): AttentionChip => ({
  level: 'high',
  icon: '!',
  tone: 'wait',
  totalPoints: 120,
  pendingCount: 2,
  oldestRequestedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
  latestReason: 'Pick retry policy',
  ...over,
});

function fakeApi(requests: AttentionRequest[], over: Partial<AttentionApi> = {}): AttentionApi {
  const row: AttentionQueueRow = {
    rootId: TASK,
    title: 'Wire refund webhook',
    kind: 'task',
    chip: chip({ pendingCount: requests.length }),
    requests,
    latest: requests[0]!,
    seen: false,
    mine: true,
    rolledUp: requests.filter((r) => r.entityId !== TASK).length,
  };
  const rows = requests.length ? [row] : [];
  return {
    status: 'ready',
    error: null,
    undo: null,
    chipFor: () => (requests.length ? chip({ pendingCount: requests.length }) : null),
    raisedChipFor: (id) => (requests.some((r) => r.sourceWorkSessionId === id) ? chip({ latestReason: requests[0]!.reason }) : null),
    counts: () => ({ mine: rows.length, all: rows.length }),
    queue: () => rows,
    requestsFor: (root) => requests.filter((r) => (r.rootId ?? r.entityId) === root),
    markSeen: vi.fn(async () => {}),
    resolve: vi.fn(async () => {}),
    unresolve: vi.fn(async () => {}),
    withdraw: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    refresh: vi.fn(),
    ...over,
  };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('AttentionBlock (tab 3, variant A)', () => {
  const two = [
    request({ id: 'r1' }),
    request({
      id: 'r2',
      reason: 'Merge conflict in webhooks/refund.ts on cherry-pick',
      level: 'normal',
      actionType: 'review',
      entityId: SESSION_2,
      sourceWorkSessionId: SESSION_2,
      sourceSessionLive: false,
      createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    }),
  ];

  it('lists every request with reason, tags, source and via line; Resolve all settles the root with the note', async () => {
    const api = fakeApi(two);
    const open = vi.fn();
    render(
      <AttentionApiProvider api={api}>
        <AttentionBlock entityId={TASK} noun="task" onOpenEntity={open} />
      </AttentionApiProvider>,
    );
    expect(screen.getByTestId('attention-block').textContent).toContain('2 requests need you');
    expect(screen.getAllByTestId('attention-block-row')).toHaveLength(2);
    expect(screen.getByText('Pick retry policy: 3× fixed or exponential up to 1h?')).toBeTruthy();
    expect(screen.getByText('review')).toBeTruthy();
    expect(screen.getByText(`via session ${shortSessionId(SESSION_2)}`)).toBeTruthy();
    expect(screen.getByText('Note — sent to 2 sessions')).toBeTruthy();

    fireEvent.click(screen.getAllByTestId('attention-block-source')[0]!);
    expect(open).toHaveBeenCalledWith(SESSION);

    fireEvent.change(screen.getByTestId('attention-block-note'), { target: { value: 'exponential, cap 1h' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('attention-block-resolve'));
    });
    expect(api.resolve).toHaveBeenCalledWith(TASK, 'exponential, cap 1h');
  });

  it('opening marks the entity seen (once for the unseen set), and never resolves', () => {
    const api = fakeApi(two);
    const { rerender } = render(
      <AttentionApiProvider api={api}>
        <AttentionBlock entityId={TASK} />
      </AttentionApiProvider>,
    );
    rerender(
      <AttentionApiProvider api={api}>
        <AttentionBlock entityId={TASK} />
      </AttentionApiProvider>,
    );
    expect(api.markSeen).toHaveBeenCalledTimes(1);
    expect(api.markSeen).toHaveBeenCalledWith(TASK);
    expect(api.resolve).not.toHaveBeenCalled();
  });

  it('hides when nothing is open and when no module is mounted', () => {
    const { container, rerender } = render(
      <AttentionApiProvider api={fakeApi([])}>
        <AttentionBlock entityId={TASK} />
      </AttentionApiProvider>,
    );
    expect(container.innerHTML).toBe('');
    rerender(<AttentionBlock entityId={TASK} />);
    expect(container.innerHTML).toBe('');
  });

  it('collapses per entity and remembers it', () => {
    const api = fakeApi(two);
    const { unmount } = render(
      <AttentionApiProvider api={api}>
        <AttentionBlock entityId={TASK} />
      </AttentionApiProvider>,
    );
    fireEvent.click(screen.getByTestId('attention-block-toggle'));
    expect(screen.queryAllByTestId('attention-block-row')).toHaveLength(0);
    unmount();
    render(
      <AttentionApiProvider api={api}>
        <AttentionBlock entityId={TASK} />
      </AttentionApiProvider>,
    );
    expect(screen.getByTestId('attention-block').getAttribute('data-collapsed')).toBe('true');
  });

  it('Withdraw appears only for the raising agent session, never for a human viewer', () => {
    const api = fakeApi([request({ id: 'r1' })]);
    const { rerender } = render(
      <AttentionApiProvider api={api}>
        <AttentionBlock entityId={TASK} />
      </AttentionApiProvider>,
    );
    expect(screen.queryByText('Withdraw')).toBeNull();
    rerender(
      <AttentionApiProvider api={api}>
        <AttentionBlock entityId={TASK} viewerSessionId={SESSION} />
      </AttentionApiProvider>,
    );
    fireEvent.click(screen.getByText('Withdraw'));
    expect(api.withdraw).toHaveBeenCalledWith('r1');
  });

  it('the legacy dock yields to the block when a module is mounted', () => {
    const { container, rerender } = render(<LegacyAttentionDock><p>old dock</p></LegacyAttentionDock>);
    expect(container.textContent).toBe('old dock');
    rerender(
      <AttentionApiProvider api={fakeApi([])}>
        <LegacyAttentionDock><p>old dock</p></LegacyAttentionDock>
      </AttentionApiProvider>,
    );
    expect(container.textContent).toBe('');
  });
});

describe('SessionWaitingBanner (tab 4)', () => {
  it('shows the REAL reason the session raised on its task, with Resolve and Reply', async () => {
    const api = fakeApi([request({ id: 'r1' })]);
    render(
      <AttentionApiProvider api={api}>
        <SessionWaitingBanner sessionId={SESSION} legacy={<p>quiet pty</p>} />
      </AttentionApiProvider>,
    );
    expect(screen.getByTestId('session-waiting-reason').textContent).toBe(
      'Pick retry policy: 3× fixed or exponential up to 1h?',
    );
    expect(screen.getByTestId('session-waiting-banner').textContent).toContain('on task Wire refund webhook');
    expect(screen.queryByText('quiet pty')).toBeNull();

    fireEvent.click(screen.getByTestId('session-waiting-reply'));
    fireEvent.change(screen.getByTestId('session-waiting-input'), { target: { value: 'use exponential' } });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('session-waiting-input').closest('form')!);
    });
    expect(api.reply).toHaveBeenCalledWith(SESSION, 'use exponential');
    expect(api.resolve).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('session-waiting-resolve'));
    await act(async () => {
      fireEvent.submit(screen.getByTestId('session-waiting-input').closest('form')!);
    });
    expect(api.resolve).toHaveBeenCalledWith(TASK, undefined);
  });

  it('shows only what THIS session raised, not a sibling session\'s newer request on the same task', () => {
    const api = fakeApi([
      request({ id: 'mine', reason: 'Mine: pick retry policy', createdAt: new Date(Date.now() - 3 * HOUR).toISOString() }),
      request({ id: 'theirs', reason: 'Theirs: approve psql', sourceWorkSessionId: SESSION_2, createdAt: new Date().toISOString() }),
    ]);
    render(
      <AttentionApiProvider api={api}>
        <SessionWaitingBanner sessionId={SESSION} />
      </AttentionApiProvider>,
    );
    expect(screen.getByTestId('session-waiting-reason').textContent).toBe('Mine: pick retry policy');
    expect(screen.getByTestId('session-waiting-banner').textContent).not.toContain('Theirs');
  });

  it('PTY silence alone draws nothing once a module is mounted (G1); legacy stands without one', () => {
    const { container, rerender } = render(
      <AttentionApiProvider api={fakeApi([])}>
        <SessionWaitingBanner sessionId={SESSION} legacy={<p>quiet pty</p>} />
      </AttentionApiProvider>,
    );
    expect(container.textContent).toBe('');
    rerender(<SessionWaitingBanner sessionId={SESSION} legacy={<p>quiet pty</p>} />);
    expect(container.textContent).toBe('quiet pty');
  });
});

describe('tile lines (F1 two marks, tab 5 roll-up)', () => {
  it('the asking session carries `waiting on you` while the task is counted once', () => {
    const api = fakeApi([request({ id: 'r1' })]);
    render(
      <AttentionApiProvider api={api}>
        <AttentionTileSubtitle row={{ id: SESSION, kind: 'work_session' }} />
        <AttentionTileSubtitle row={{ id: SESSION, kind: 'work_session' }} ended />
      </AttentionApiProvider>,
    );
    const lines = screen.getAllByTestId('attention-tile-subtitle').map((n) => n.textContent);
    expect(lines).toEqual([
      'waiting on you: Pick retry policy: 3× fixed or exponential up to 1h?',
      'ended · waiting on you: Pick retry policy: 3× fixed or exponential up to 1h?',
    ]);
    expect(api.counts()).toEqual({ mine: 1, all: 1 });
  });

  it('a roll-up root reads `n requests · own, via …`', () => {
    const reqs = [
      request({ id: 'a', entityId: TASK }),
      request({ id: 'b', entityId: TASK }),
      request({ id: 'c', entityId: SESSION_2, sourceWorkSessionId: SESSION_2 }),
    ];
    expect(rollupLine(TASK, reqs)).toBe(`3 requests · 2 own, 1 via session ${shortSessionId(SESSION_2)}`);
    expect(rollupLine(TASK, reqs.slice(0, 2))).toBeNull();
    expect(sessionWaitingLine('x', false)).toBe('waiting on you: x');
  });
});

describe('phone header button (tab 7)', () => {
  it('shows the mine count and opens on tap; hidden when nothing waits', () => {
    const onOpen = vi.fn();
    const { container, rerender } = render(
      <AttentionApiProvider api={fakeApi([request({ id: 'r1' })])}>
        <AttentionHeaderButton expanded={false} onOpen={onOpen} />
      </AttentionApiProvider>,
    );
    const button = screen.getByTestId('attention-phone-button');
    expect(button.textContent).toBe('!1');
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalled();
    rerender(
      <AttentionApiProvider api={fakeApi([])}>
        <AttentionHeaderButton expanded={false} onOpen={onOpen} />
      </AttentionApiProvider>,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('"Needs me" = the queue (tab 8)', () => {
  const summary = { id: TASK, kind: 'task', title: 'Wire refund webhook' } as unknown as EntitySummary;
  const base = {
    rowsFor: vi.fn((_f?: unknown) => [] as readonly EntitySummary[]),
    pageStateOf: vi.fn((_f?: unknown) => ({ hasMore: true, loading: false })),
    loadMore: vi.fn((_f?: unknown) => {}),
  };

  it('with needs-me active, rows are queue(mine) roots in queue order, never the server page', () => {
    const api = fakeApi([request({ id: 'r1' })]);
    const src = needsMeListSource(api, 'task', { detailOf: (id) => (id === TASK ? summary : undefined) }, base);
    expect(src.rowsFor({ needsActorId: 'me' })).toEqual([summary]);
    expect(src.pageStateOf({ needsActorId: 'me' })).toEqual({ hasMore: false, loading: false });
    src.loadMore({ needsActorId: 'me' });
    expect(base.rowsFor).not.toHaveBeenCalled();
    expect(base.loadMore).not.toHaveBeenCalled();
    src.rowsFor({ status: ['open'] });
    expect(base.rowsFor).toHaveBeenCalledTimes(1);
  });

  it('a root off the loaded page is pulled by id, not dropped silently', async () => {
    const api = fakeApi([request({ id: 'r1' })]);
    const pull = vi.fn();
    const data = { detailOf: () => undefined, pull };
    const src = needsMeListSource(api, 'task', data, base);
    expect(src.rowsFor({ needsActorId: 'me' })).toEqual([]);
    src.rowsFor({ needsActorId: 'me' });
    await Promise.resolve();
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledWith(TASK);
  });

  it('mine = 0 is an empty list, never a fallback to all; no module passes through', () => {
    const empty = fakeApi([]);
    expect(needsMeListSource(empty, 'task', { detailOf: () => summary }, base).rowsFor({ needsActorId: 'me' })).toEqual([]);
    expect(needsMeListSource(null, 'task', { detailOf: () => summary }, base)).toBe(base);
  });
});
