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
import { AttentionHeaderButton } from './AttentionSheet';
import { LegacyAttentionDock } from './LegacyAttentionDock';
import { needsMeListSource, needsMeLoading, needsMeRows, PULL_PATIENCE_MS, resetNeedsMePulls } from './needs-me';
import { EntityListPanel } from '../panels';
import { getKind, type ActionContext, type QueryFilter } from '../domain';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
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
    expect(screen.getByTestId('attention-block').textContent).toContain('2 requests waiting');
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

  it('on a session\'s own detail it lists what others pinned there, not what it raised; opening marks all seen', () => {
    const api = fakeApi([
      request({ id: 'raised', entityId: SESSION, rootId: SESSION }),
      request({ id: 'pinned', entityId: SESSION, rootId: SESSION, sourceWorkSessionId: null, origin: 'human', reason: 'Human asks the session' }),
    ]);
    render(
      <AttentionApiProvider api={api}>
        <AttentionBlock entityId={SESSION} excludeRaisedBy={SESSION} />
      </AttentionApiProvider>,
    );
    expect(screen.getAllByTestId('attention-block-row')).toHaveLength(1);
    expect(screen.getByText('Human asks the session')).toBeTruthy();
    expect(api.markSeen).toHaveBeenCalledWith(SESSION);
  });

  it('with only raised requests on a session, the block hides but opening still marks seen', () => {
    const api = fakeApi([request({ id: 'raised', entityId: SESSION, rootId: SESSION })]);
    const { container } = render(
      <AttentionApiProvider api={api}>
        <AttentionBlock entityId={SESSION} excludeRaisedBy={SESSION} />
      </AttentionApiProvider>,
    );
    expect(container.innerHTML).toBe('');
    expect(api.markSeen).toHaveBeenCalledWith(SESSION);
  });

  it('a failed Resolve gives the typed note back', async () => {
    const reqs = [request({ id: 'r1' })];
    let api = fakeApi(reqs);
    const view = render(
      <AttentionApiProvider api={api}>
        <AttentionBlock entityId={TASK} />
      </AttentionApiProvider>,
    );
    fireEvent.change(screen.getByTestId('attention-block-note'), { target: { value: 'cap at 1h' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('attention-block-resolve'));
    });
    expect((screen.getByTestId('attention-block-note') as HTMLInputElement).value).toBe('');
    api = { ...api, error: "Couldn't resolve: 500" };
    view.rerender(
      <AttentionApiProvider api={api}>
        <AttentionBlock entityId={TASK} />
      </AttentionApiProvider>,
    );
    expect((screen.getByTestId('attention-block-note') as HTMLInputElement).value).toBe('cap at 1h');
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

  it('Resolve settles ONE root, and says first what else on it that settles', async () => {
    const DOC = '01a0dd99-0000-7000-8000-0000000d0c01' as EntityId;
    const api = fakeApi([
      request({ id: 'mine-task', createdAt: new Date(Date.now() - 1000).toISOString() }),
      request({ id: 'sibling', sourceWorkSessionId: SESSION_2, reason: 'Theirs' }),
      request({ id: 'mine-doc', entityId: DOC, rootId: DOC, createdAt: new Date(Date.now() - 5 * HOUR).toISOString() }),
    ], {
      queue: () => {
        const reqs = [
          request({ id: 'mine-task', createdAt: new Date(Date.now() - 1000).toISOString() }),
          request({ id: 'sibling', sourceWorkSessionId: SESSION_2, reason: 'Theirs' }),
        ];
        const doc = [request({ id: 'mine-doc', entityId: DOC, rootId: DOC, createdAt: new Date(Date.now() - 5 * HOUR).toISOString() })];
        return [
          { rootId: TASK, title: 'Wire refund webhook', kind: 'task', chip: chip(), requests: reqs, latest: reqs[0]!, seen: false, mine: true, rolledUp: 0 },
          { rootId: DOC, title: 'Runbook', kind: 'doc', chip: chip(), requests: doc, latest: doc[0]!, seen: false, mine: true, rolledUp: 0 },
        ];
      },
    });
    render(
      <AttentionApiProvider api={api}>
        <SessionWaitingBanner sessionId={SESSION} />
      </AttentionApiProvider>,
    );
    expect(screen.getByTestId('session-waiting-banner').textContent).toContain('+1 more elsewhere');
    fireEvent.click(screen.getByTestId('session-waiting-resolve'));
    expect(screen.getByTestId('session-waiting-scope').textContent).toBe(
      'Resolves every open request on task Wire refund webhook, including 1 from other sessions.',
    );
    await act(async () => {
      fireEvent.submit(screen.getByTestId('session-waiting-input').closest('form')!);
    });
    expect(api.resolve).toHaveBeenCalledTimes(1);
    expect(api.resolve).toHaveBeenCalledWith(TASK, undefined);
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

describe('tile lines (F1 two marks, tab 5 roll-up) — through the real EntityListPanel tile', () => {
  const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
  const of = (kind: string) => fixtureSummaries.find((row) => row.kind === kind)!;
  const panel = (api: AttentionApi, kind: string, row: EntitySummary) =>
    render(
      <AttentionApiProvider api={api}>
        <EntityListPanel kind={kind} rowsFor={() => [row]} ctx={ctx} />
      </AttentionApiProvider>,
    );

  it('premise: the three tile branches are session-tree, control-card and standard', () => {
    expect(getKind('work_session').list.tile.anatomy).toBe('session-tree');
    expect(getKind('task').list.tile.anatomy).toBe('control-card');
    expect(['session-tree', 'control-card']).not.toContain(getKind('doc').list.tile.anatomy);
  });

  it('session-tree: the asking session carries `waiting on you` (F1) while the task counts once', () => {
    const session = { ...of('work_session'), id: SESSION };
    const api = fakeApi([request({ id: 'r1' })]);
    panel(api, 'work_session', session);
    const line = screen.getByTestId('attention-tile-subtitle');
    expect(line.textContent).toBe('waiting on you: Pick retry policy: 3× fixed or exponential up to 1h?');
    expect(line.getAttribute('title')).toBe(line.textContent);
    expect(api.counts()).toEqual({ mine: 1, all: 1 });
  });

  it('control-card: a task root reads `n requests · own, via session`', () => {
    const task = { ...of('task'), id: TASK };
    panel(fakeApi([
      request({ id: 'a' }),
      request({ id: 'b' }),
      request({ id: 'c', entityId: SESSION_2, sourceWorkSessionId: SESSION_2 }),
    ]), 'task', task);
    expect(screen.getByTestId('attention-tile-subtitle').textContent).toBe(
      `3 requests · 2 own, 1 via session ${shortSessionId(SESSION_2)}`,
    );
  });

  it('standard: any other root with rolled-up requests reads the same line', () => {
    const doc = of('doc');
    panel(fakeApi([
      request({ id: 'a', entityId: doc.id, rootId: doc.id, sourceWorkSessionId: null }),
      request({ id: 'b', entityId: SESSION_2, rootId: doc.id, sourceWorkSessionId: SESSION_2 }),
    ]), 'doc', doc);
    expect(screen.getByTestId('attention-tile-subtitle').textContent).toBe(
      `2 requests · 1 own, 1 via session ${shortSessionId(SESSION_2)}`,
    );
  });

  it('line helpers', () => {
    expect(sessionWaitingLine('x', true)).toBe('ended · waiting on you: x');
    expect(rollupLine(TASK, [request({ id: 'a' })])).toBeNull();
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
  beforeEach(() => resetNeedsMePulls());
  const summary = { id: TASK, kind: 'task', title: 'Wire refund webhook' } as unknown as EntitySummary;
  const base = () => ({
    rowsFor: vi.fn((_f?: unknown) => [] as readonly EntitySummary[]),
    pageStateOf: vi.fn((_f?: unknown) => ({ hasMore: true, loading: false })),
    loadMore: vi.fn((_f?: unknown) => {}),
  });

  it('with needs-me active, rows are queue(mine) roots in queue order, never the server page', () => {
    const src0 = base();
    const src = needsMeListSource(fakeApi([request({ id: 'r1' })]), 'task', { detailOf: (id) => (id === TASK ? summary : undefined) }, src0);
    expect(src.rowsFor({ needsActorId: 'me' })).toEqual([summary]);
    expect(src.pageStateOf({ needsActorId: 'me' })).toEqual({ hasMore: false, loading: false });
    src.loadMore({ needsActorId: 'me' });
    expect(src0.rowsFor).not.toHaveBeenCalled();
    expect(src0.loadMore).not.toHaveBeenCalled();
    src.rowsFor({ status: ['open'] });
    expect(src0.rowsFor).toHaveBeenCalledTimes(1);
  });

  it('a root off the loaded page is pulled by id once, and the list says LOADING until it lands', async () => {
    const pull = vi.fn();
    const src = needsMeListSource(fakeApi([request({ id: 'r1' })]), 'task', { detailOf: () => undefined, pull }, base());
    expect(src.rowsFor({ needsActorId: 'me' })).toEqual([]);
    src.rowsFor({ needsActorId: 'me' });
    await Promise.resolve();
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledWith(TASK);
    expect(src.pageStateOf({ needsActorId: 'me' }).loading).toBe(true);
  });

  it('a root that never lands stops reading as loading after the patience window', () => {
    const api = fakeApi([request({ id: 'r1' })]);
    const data = { detailOf: () => undefined, pull: vi.fn() };
    const t0 = 1_000_000;
    needsMeRows(api, 'task', data, t0);
    expect(needsMeLoading(api, 'task', data, t0 + 1)).toBe(true);
    expect(needsMeLoading(api, 'task', data, t0 + PULL_PATIENCE_MS + 1)).toBe(false);
  });

  it('mine = 0 is an empty list, never a fallback to all; no module passes through', () => {
    const src0 = base();
    expect(needsMeListSource(fakeApi([]), 'task', { detailOf: () => summary }, src0).rowsFor({ needsActorId: 'me' })).toEqual([]);
    expect(needsMeListSource(null, 'task', { detailOf: () => summary }, src0)).toBe(src0);
  });

  it('BANDED: through the real task list, Needs me is ONE flat list — tabs do not repeat or narrow it', () => {
    localStorage.clear();
    const TASK_ROW = fixtureSummaries.find((r) => r.kind === 'task')!;
    const mine = { ...TASK_ROW, id: TASK, title: 'Wire refund webhook', category: 'in_progress' } as EntitySummary;
    const other = { ...TASK_ROW, id: 'other-task' as EntitySummary['id'], title: 'Unrelated open task', category: 'to_do' } as EntitySummary;
    const server = vi.fn((filter: QueryFilter) =>
      [mine, other].filter((r) => !filter.category || filter.category.includes(r.category as never)),
    );
    const api = fakeApi([request({ id: 'r1' })]);
    const src = needsMeListSource(api, 'task', { detailOf: (id) => (id === TASK ? mine : undefined) }, {
      rowsFor: server as never,
      pageStateOf: (() => ({ hasMore: false, loading: false })) as never,
      loadMore: (() => {}) as never,
    });
    const view = render(
      <AttentionApiProvider api={api}>
        <EntityListPanel kind="task" rowsFor={src.rowsFor} pageStateOf={src.pageStateOf} ctx={{ spaceId: FIXTURE_SPACE_ID, viewerActorId: 'me' }} />
      </AttentionApiProvider>,
    );
    fireEvent.click(view.getByTestId('filter-trigger'));
    fireEvent.click(view.getByRole('menuitemcheckbox', { name: /^Needs me$/ }));
    const count = () => (view.container.textContent ?? '').split('Wire refund webhook').length - 1;
    expect(view.getByTestId('needs-me-note')).toBeTruthy();
    expect(count()).toBe(1);
    expect(view.container.textContent).not.toContain('Unrelated open task');
    fireEvent.click(view.getByRole('tab', { name: /^Done/ }));
    expect(count()).toBe(1);
    expect(server.mock.calls.every(([f]) => !('needsActorId' in (f as object)))).toBe(true);
  });
});
