// @vitest-environment jsdom
/**
 * THE TURN RECEIPT, RENDERED (proposal 01a14a8d direction B, approved) — one
 * compact row per entity per run; what the chat MADE is drawn exactly once,
 * what it READ is not; the trailing slot says what is true NOW; a worker is a
 * pill on its task's row; a row opens the thing it names, from the keyboard.
 *
 * The fixture thread is shaped like this node's real transcripts (2026-09-26):
 * MCP results arrive as JSON strings, entity writes answer with a
 * `tm8.receipt.v1`, a refused call is `state: 'error'` plus an error envelope,
 * and one create is replayed. It is rendered the way `ChatHomeScreen` renders
 * it — one `TurnParts` per turn over ONE thread fold, inside the host
 * provider — so the cross-turn claims (dedupe, from-sides) are the real ones.
 */
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityDetail, EntityId } from '@tm8/contract';
import type { SessionLiveness } from '../data/seam';
import { resetChatEntityResolutionCache } from './EntityChip';
import { resetFleetEntityCache } from './fleet/use-fleet-entities';
import { buildChatLedger } from './ledger';
import { LedgerHostProvider, SESSION_VERDICT_TICK_MS, STATUS_NOW_TICK_MS, type LedgerHost } from './ledger-host';
import { TurnParts } from './TurnParts';
import type { ChatTurn, ChatTurnPart } from './types';

const id = (n: number): string => `01a0dc90-0000-7000-8000-${String(n).padStart(12, '0')}`;

const PROGRAM = id(1); // an existing parent the thread never read
const P1 = id(2);
const C1 = id(3);
const C2 = id(4);
const SESSION = id(5);
const MEMORY = id(6);
const READ_A = id(7);
const READ_B = id(8);

const ACT = 'mcp__tm8__tm8_act';
const DELEGATE = 'mcp__tm8__tm8_delegate';

let seq = 0;
let turnNo = 0;

function callParts(
  name: string,
  args: unknown,
  result: unknown,
  outcome: { state?: 'running' | 'completed' | 'error'; isError?: boolean } = {},
): ChatTurnPart[] {
  const toolCallId = `tc-${(seq += 1)}`;
  const parts: ChatTurnPart[] = [
    { kind: 'tool_call', seq: (seq += 1), toolCallId, name, args, state: outcome.state ?? 'completed' },
  ];
  if (result !== undefined) {
    parts.push({
      kind: 'tool_result',
      seq: (seq += 1),
      toolCallId,
      content: result,
      ...(outcome.isError !== undefined ? { isError: outcome.isError } : {}),
    });
  }
  return parts;
}

function turn(...parts: ChatTurnPart[][]): ChatTurn {
  return {
    messageId: `msg-${(turnNo += 1)}` as EntityId,
    role: 'assistant',
    author: null,
    createdAt: '2026-09-26T07:00:00.000Z',
    body: '',
    parts: parts.flat(),
  };
}

const mcp = (tool: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ schemaVersion: 'tm8.mcp.result.v1', tool, ...payload });
const receipt = (fields: Record<string, unknown>) => ({ schemaVersion: 'tm8.receipt.v1', ok: true, ...fields });

const createTask = (entityId: string, title: string, parentId: string | null) =>
  callParts(
    ACT,
    { operation: 'entities.create', body: { spaceId: 'sp', kind: 'task', title, parentId } },
    mcp('tm8_act', { operation: 'entities.create', data: receipt({ op: 'entity.create', id: entityId, kind: 'task', title, parentId, status: { to: 'open' } }) }),
  );

/** The fixture thread: 5 creates (one replayed), 2 transitions, 1 refused
 *  complete, 1 edit, and reads in two turns. */
function fixtureThread(): ChatTurn[] {
  return [
    turn(
      callParts(
        'mcp__tm8__tm8_read',
        { operation: 'collections.query', body: { kinds: ['task'] } },
        mcp('tm8_read', {
          data: {
            items: [
              { id: READ_A, kind: 'task', title: 'Existing A', state: { kind: 'task', status: 'open' } },
              { id: READ_B, kind: 'task', title: 'Existing B', state: { kind: 'task', status: 'working' } },
            ],
          },
        }),
      ),
      createTask(P1, 'Containers P1 — docker provider', PROGRAM),
      createTask(C1, 'Provider interface', P1),
      createTask(C2, 'Docker socket lifecycle', P1),
    ),
    turn(
      callParts(
        DELEGATE,
        { operation: 'execution.spawn', body: { teamMemberId: id(9), taskIds: [P1], mode: 'coordinated-worker' } },
        mcp('tm8_delegate', {
          data: { entity: { id: SESSION, kind: 'work_session', title: 'Worker · provider interface', state: { kind: 'work_session', status: 'running', model: 'claude-opus-5-5' } } },
        }),
      ),
      // Refused: unticked criteria. Must draw nothing.
      callParts(
        ACT,
        { operation: 'entities.commands.complete', params: { id: C1 }, body: { expectedVersion: 1 } },
        JSON.stringify({ schemaVersion: 'tm8.mcp.error.v1', error: { code: 'acceptance_incomplete', message: 'unticked' } }),
        { state: 'error', isError: true },
      ),
      callParts(
        ACT,
        { operation: 'entities.commands.work', params: { id: C2 }, body: { status: 'working' } },
        mcp('tm8_act', { data: receipt({ op: 'task.transition', id: C2, kind: 'task', title: 'Docker socket lifecycle', status: { from: 'open', to: 'working' }, changed: ['state.status'] }) }),
      ),
    ),
    turn(
      // The replay: the same entity answered again. One card, not two.
      createTask(P1, 'Containers P1 — docker provider', PROGRAM),
      callParts(
        ACT,
        { operation: 'entities.commands.complete', params: { id: C2 }, body: { expectedVersion: 2 } },
        mcp('tm8_act', { data: receipt({ op: 'task.complete', id: C2, kind: 'task', status: { to: 'done' } }) }),
      ),
      callParts(
        ACT,
        { operation: 'entities.commands.tick', params: { id: C1 }, body: { criterionIds: ['c1'] } },
        mcp('tm8_act', { data: receipt({ op: 'task.tick', id: C1, kind: 'task', changed: ['content.acceptanceCriteria'] }) }),
      ),
      callParts(
        'mcp__tm8__memory_write',
        { spaceId: 'sp', statement: 'Spawn, do not dispatch' },
        mcp('memory_write', { data: { entity: { id: MEMORY, kind: 'memory', title: 'Spawn, do not dispatch' } } }),
      ),
    ),
    turn(
      callParts(
        'mcp__tm8__tm8_read',
        { operation: 'entities.get', params: { id: P1 } },
        mcp('tm8_read', { data: { entity: { id: P1, kind: 'task', title: 'Containers P1 — docker provider', state: { kind: 'task', status: 'open' } } } }),
      ),
    ),
  ];
}

function Transcript({
  turns,
  host = {},
  onOpenEntity,
  thread = 'thread-1',
  generation = 0,
}: {
  turns: ChatTurn[];
  host?: LedgerHost;
  onOpenEntity?: (id: EntityId) => void;
  /** Keys the provider, as ChatHomeScreen keys it by the open thread. */
  thread?: string;
  /** Bumping it REMOUNTS every turn under the same provider — what a run's
   *  step list regrouping around a card does to it. */
  generation?: number;
}) {
  const ledger = buildChatLedger(turns);
  return (
    <LedgerHostProvider key={thread} {...host}>
      {turns.map((t) => (
        <article key={`${t.messageId}:${generation}`} data-testid="turn">
          <TurnParts
            parts={t.parts}
            ledger={ledger}
            turnMessageId={t.messageId}
            onOpenEntity={onOpenEntity}
            resolveEntity={host.resolveEntity}
          />
        </article>
      ))}
    </LedgerHostProvider>
  );
}

const sessionDetail = (status: string): EntityDetail =>
  ({ id: SESSION, kind: 'work_session', title: 'Worker · provider interface', state: { kind: 'work_session', status } }) as unknown as EntityDetail;

beforeEach(() => {
  resetFleetEntityCache();
  resetChatEntityResolutionCache();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});


const rowsIn = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.tch-rrow')];
const titleOf = (row: HTMLElement): string => row.querySelector('.tch-rrow__title')?.textContent ?? '';
const stateOf = (row: HTMLElement): string | null => within(row).queryByTestId('chat-receipt-state')?.textContent ?? null;

describe('the fixture thread — one row per entity per run, each write drawn exactly once', () => {
  it('draws one receipt per run and one row per created id across the whole thread, none for reads', () => {
    const onOpenEntity = vi.fn();
    const view = render(<Transcript turns={fixtureThread()} onOpenEntity={onOpenEntity} />);
    const turns = view.getAllByTestId('turn');

    // P1, its two children, the memory — P1's replay in turn 3 is NOT a row.
    const created = view.getAllByTestId('chat-ledger-create');
    expect(created.map((row) => row.dataset.kind)).toEqual(['task', 'task', 'task', 'memory']);
    created.forEach((row) => fireEvent.click(within(row).getAllByRole('button')[0]!));
    expect(onOpenEntity.mock.calls.map(([opened]) => opened)).toEqual([P1, C1, C2, MEMORY]);

    // Turn 1: the children nest under the parent made beside them.
    expect(rowsIn(turns[0]!).map((row) => [titleOf(row), row.dataset.depth ?? '0'])).toEqual([
      ['Containers P1 — docker provider', '0'],
      ['Provider interface', '1'],
      ['Docker socket lifecycle', '1'],
    ]);
    // Turn 3 holds the replay: only the memory is made, C2 moved, C1 edited.
    expect(rowsIn(turns[2]!).map((row) => row.dataset.mark)).toEqual(['moved', 'edited', 'made']);
    // A memory has no title: its statement names it, never just "Memory".
    expect(titleOf(rowsIn(turns[2]!)[2]!)).toBe('Spawn, do not dispatch');

    // Reads stay the quiet counted sentence — never a row.
    expect(view.getAllByTestId('chat-ledger-reads')).toHaveLength(2);
    const drawn = view.getAllByTestId('chat-receipt').map((r) => r.textContent ?? '').join(' | ');
    expect(drawn).not.toContain('Existing A');
    expect(within(turns[3]!).queryByTestId('chat-receipt')).toBeNull();
    // No "Created" pill anywhere: the mark says it.
    expect(drawn).not.toMatch(/created/i);
  });

  it('writes leave the step list — the receipt row IS the step; the header still counts every step', () => {
    const view = render(<Transcript turns={[fixtureThread()[0]!]} />);
    const head = view.getByTestId('chat-steps-head');
    expect(head.textContent).toMatch(/^4 steps · read 2 tasks/);
    expect(head.textContent).not.toContain('Created');
    // The live turn's only run is open: its list holds the read, not the writes.
    const lines = view.getAllByTestId('chat-step-line').map((line) => line.textContent ?? '');
    expect(lines).toEqual([expect.stringContaining('Read 2 tasks')]);
  });

  it('a moved row shows the status NOW, and keeps the move — with the server’s from-side — in its title', () => {
    const view = render(<Transcript turns={fixtureThread()} />);
    const [, second, third] = view.getAllByTestId('turn');
    const moved = rowsIn(second!).find((row) => row.dataset.mark === 'moved')!;
    expect(titleOf(moved)).toBe('Docker socket lifecycle');
    expect(moved.getAttribute('title')).toBe('to do → working');
    // The thread later finished it: every row for it now says done.
    expect(stateOf(moved)).toBe('done');
    const done = rowsIn(third!).find((row) => row.dataset.mark === 'moved')!;
    expect(done.getAttribute('title')).toBe('working → done');
    expect(within(done).getByTestId('chat-receipt-state').dataset.tone).toBe('done');
  });

  it('a refused write is ONE red row with the server’s reason, where it happened — never a detached errline', () => {
    const view = render(<Transcript turns={fixtureThread()} />);
    const second = view.getAllByTestId('turn')[1]!;
    const refused = rowsIn(second).filter((row) => row.dataset.mark === 'failed');
    expect(refused).toHaveLength(1);
    expect(titleOf(refused[0]!)).toBe('Moving “Provider interface” to done failed');
    expect(refused[0]!.textContent).toContain('unticked');
    expect(within(second).queryByTestId('chat-step-errline')).toBeNull();
    expect(within(second).getByTestId('chat-steps-head').textContent).toContain('1 failed');
  });

  it('says where a create landed only when its parent is not a row beside it', async () => {
    const resolveEntity = vi.fn(async (entityId: EntityId) =>
      entityId === PROGRAM ? { id: PROGRAM, kind: 'task', title: 'Containers program' } : { id: entityId },
    );
    const view = render(<Transcript turns={[fixtureThread()[0]!]} host={{ resolveEntity }} />);
    const [p1, c1] = view.getAllByTestId('chat-ledger-create');
    // A parent the thread never read resolves lazily through the chips' cache.
    await vi.waitFor(() => expect(within(p1!).getByTestId('chat-receipt-meta').textContent).toBe('under Containers program'));
    expect(resolveEntity).toHaveBeenCalledWith(PROGRAM);
    // The child's parent is the row above it: the indent says so, the meta does not.
    expect(within(c1!).queryByTestId('chat-receipt-meta')).toBeNull();
    expect(view.container.textContent).not.toContain(PROGRAM.slice(0, 8));
  });
});

describe('the screenshot case — a task and the worker spawned on it', () => {
  const TASK = id(30);
  const WORKER = id(31);
  const TITLE = 'New chat: stop the loading page after Send (draft → entity tab remount)';
  const screenshot = (): ChatTurn[] => [
    turn(
      createTask(TASK, TITLE, null),
      callParts(
        DELEGATE,
        { operation: 'execution.spawn', body: { teamMemberId: id(9), taskIds: [TASK], mode: 'coordinated-worker' } },
        mcp('tm8_delegate', { data: { entity: { id: WORKER, kind: 'work_session', title: TITLE, state: { kind: 'work_session', status: 'running', model: 'claude-opus-5-5' } } } }),
      ),
    ),
  ];

  it('is ONE row: the title once, the worker a pill on it, no duplicate step line', () => {
    const onOpenEntity = vi.fn();
    const view = render(<Transcript turns={screenshot()} onOpenEntity={onOpenEntity} host={{ models: [{ model: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'anthropic', agentTool: 'claude-code' }] }} />);
    const rows = rowsIn(view.container);
    expect(rows).toHaveLength(1);
    expect(view.container.textContent!.split(TITLE)).toHaveLength(2);
    const pill = within(rows[0]!).getByTestId('chat-receipt-session');
    expect(pill.textContent).toContain('Worker · Opus 5.5');
    // The pill is its own control: it opens the session, the row opens the task.
    fireEvent.click(pill);
    fireEvent.click(within(rows[0]!).getAllByRole('button')[0]!);
    expect(onOpenEntity.mock.calls.map(([opened]) => opened)).toEqual([WORKER, TASK]);
    // Both writes are the row: the open list of this live run shows neither.
    expect(view.getByTestId('chat-steps-head').getAttribute('aria-expanded')).toBe('true');
    expect(view.queryAllByTestId('chat-step-line')).toHaveLength(0);
    expect(view.getByTestId('chat-steps-head').textContent).toMatch(/^2 steps/);
  });

  it('the state slot follows the task while its worker runs, and re-reads when the worker finishes', async () => {
    vi.useFakeTimers();
    let session: { status: string; outcome?: string } = { status: 'running' };
    let task = 'open';
    const readEntity = vi.fn(async (entityId: EntityId) =>
      (entityId === WORKER
        ? { id: WORKER, kind: 'work_session', title: TITLE, state: { kind: 'work_session', ...session } }
        : { id: TASK, kind: 'task', title: TITLE, state: { kind: 'task', status: task } }) as unknown as EntityDetail,
    );
    const host: LedgerHost = {
      readEntity: readEntity as unknown as LedgerHost['readEntity'],
      livenessOf: () => (session.status === 'running' ? 'live' : 'not-running'),
    };
    const view = render(<Transcript turns={screenshot()} host={host} />);
    const row = () => rowsIn(view.container)[0]!;
    // First paint: what the thread did — it made the task, so: to do.
    expect(stateOf(row())).toBe('to do');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(row()).getByTestId('chat-ledger-session-status').textContent).toBe('live');

    // The worker picks the task up. The thread never sees it; the tick does.
    task = 'working';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_NOW_TICK_MS);
    });
    expect(stateOf(row())).toBe('working');

    // The worker finishes the task and completes. Its verdict changes, and the
    // task is read once more — not stuck on what it was at the write.
    task = 'done';
    session = { status: 'exited', outcome: 'completed' };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_VERDICT_TICK_MS);
    });
    expect(within(row()).getByTestId('chat-ledger-session-status').textContent).toBe('done');
    expect(stateOf(row())).toBe('done');
    // Settled: nothing keeps asking.
    const calls = readEntity.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STATUS_NOW_TICK_MS * 3);
    });
    expect(readEntity.mock.calls.length).toBe(calls);
  });
});

describe('rows are keyboard-openable', () => {
  it('each row is a native button in the tab order, so Enter and Space open it', () => {
    const view = render(<Transcript turns={fixtureThread()} onOpenEntity={vi.fn()} />);
    for (const row of view.getAllByTestId('chat-ledger-create')) {
      const button = within(row).getAllByRole('button')[0]!;
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.tabIndex).toBe(0);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it('with no opener a row is inert — no dead button', () => {
    const view = render(<Transcript turns={fixtureThread()} />);
    expect(view.getAllByTestId('chat-ledger-create')).toHaveLength(4);
    expect(view.container.querySelector('button.tch-rrow__main')).toBeNull();
  });
});

describe('a spawned session shows its live verdict — and no word rather than a guess', () => {
  const spawnOnly = (): ChatTurn[] => [turn(fixtureThread()[1]!.parts.slice(0, 2))];

  const hostWith = (
    detail: () => Promise<EntityDetail>,
    verdict: (status: string | null) => SessionLiveness,
  ): LedgerHost => ({
    readEntity: vi.fn(detail) as unknown as LedgerHost['readEntity'],
    livenessOf: ({ status }) => verdict(status),
    models: [{ model: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'anthropic', agentTool: 'claude-code' }],
  });

  const tagOf = (view: ReturnType<typeof render>) =>
    view.queryByTestId('chat-ledger-session-status')?.textContent ?? null;

  it('with its task not in the run, the session is its own row: Worker on ◆ Task', async () => {
    const view = render(<Transcript turns={spawnOnly()} host={hostWith(async () => sessionDetail('running'), () => 'live')} />);
    const [row] = rowsIn(view.container);
    expect(row!.dataset.kind).toBe('work_session');
    expect(titleOf(row!)).toMatch(/^Worker · Opus 5\.5 on /);
    await vi.waitFor(() => expect(tagOf(view)).toBe('live'));
    expect(view.getByTestId('chat-ledger-session-status').dataset.tone).toBe('live');
  });

  it('SPEC D1: waiting when live but idle; ended / crashed while the work is open; done / stopped once settled', async () => {
    const cases: Array<[string, SessionLiveness, string, string?]> = [
      ['idle', 'live', 'waiting'],
      ['exited', 'not-running', 'ended'],
      ['failed', 'not-running', 'crashed'],
      ['exited', 'not-running', 'done', 'completed'],
      ['running', 'live', 'done', 'completed'],
      ['exited', 'not-running', 'stopped', 'stopped'],
    ];
    for (const [status, liveness, word, outcome] of cases) {
      resetFleetEntityCache();
      const detail = async () => {
        const d = sessionDetail(status);
        return outcome ? { ...d, state: { ...d.state, outcome } as typeof d.state } : d;
      };
      const view = render(<Transcript turns={spawnOnly()} host={hostWith(detail, () => liveness)} />);
      await vi.waitFor(() => expect(tagOf(view)).toBe(word));
      view.unmount();
    }
  });

  it('no word while the read is unresolved, none without a host, none for a stale record', async () => {
    const pending = render(<Transcript turns={spawnOnly()} host={hostWith(() => new Promise(() => {}), () => 'live')} />);
    expect(tagOf(pending)).toBeNull();
    pending.unmount();

    const bare = render(<Transcript turns={spawnOnly()} />);
    expect(tagOf(bare)).toBeNull();
    expect(titleOf(rowsIn(bare.container)[0]!)).toMatch(/^Worker/);
    bare.unmount();

    resetFleetEntityCache();
    const stale = render(<Transcript turns={spawnOnly()} host={hostWith(async () => sessionDetail('running'), () => 'stale')} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(tagOf(stale)).toBeNull();
  });

  it('a session that ENDS after the turn goes from live to ended on a quiet screen', async () => {
    vi.useFakeTimers();
    let live = true;
    let recorded = 'running';
    const readEntity = vi.fn(async () => sessionDetail(recorded));
    const host: LedgerHost = {
      readEntity: readEntity as unknown as LedgerHost['readEntity'],
      livenessOf: () => (live ? 'live' : 'not-running'),
    };
    const view = render(<Transcript turns={spawnOnly()} host={host} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(tagOf(view)).toBe('live');
    live = false;
    recorded = 'exited';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_VERDICT_TICK_MS);
    });
    expect(tagOf(view)).toBe('ended');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_VERDICT_TICK_MS * 3);
    });
    // One shared read, one re-read on the verdict change — not one per tick.
    expect(readEntity).toHaveBeenCalledTimes(2);
  });
});

describe('content kinds — a thumbnail and a line of what is inside', () => {
  const DOC = id(40);
  const ART = id(41);
  const DRAW = id(42);
  const content = (): ChatTurn[] => [
    turn(
      createTask(P1, 'Containers P1 — docker provider', null),
      callParts(
        'mcp__tm8__doc_create',
        { spaceId: 'sp', title: 'Design — docker provider', body: '# Design\n\nThe provider wraps the **docker** socket.\n\n' + 'word '.repeat(40), attachTo: P1 },
        mcp('doc_create', { data: receipt({ op: 'entity.create', id: DOC, kind: 'doc', title: 'Design — docker provider' }) }),
      ),
      callParts(
        'mcp__tm8__artifact_create',
        { spaceId: 'sp', name: 'Mockup', description: 'Before and after, desktop and phone', files: [{ path: 'index.html', content: 'x' }, { path: 'a.css', content: 'y' }] },
        mcp('artifact_create', { data: { entity: { id: ART, kind: 'artifact', title: 'Mockup' } } }),
      ),
      callParts(
        ACT,
        { operation: 'entities.create', body: { spaceId: 'sp', kind: 'drawing', title: 'Fold', content: { kind: 'drawing', elements: [
          { type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
          { type: 'arrow', x: 10, y: 5, width: 10, height: 0 },
          { type: 'ellipse', x: 20, y: 0, width: 10, height: 10 },
          { type: 'text', x: 0, y: 20, width: 30, height: 5 },
        ] } } },
        mcp('tm8_act', { data: receipt({ op: 'entity.create', id: DRAW, kind: 'drawing', title: 'Fold' }) }),
      ),
      callParts(ACT, { operation: 'edges.create', body: { srcId: P1, dstId: ART, type: 'produces' } }, mcp('tm8_act', { data: { ok: true } })),
      callParts(ACT, { operation: 'edges.create', body: { srcId: DRAW, dstId: P1, type: 'depends_on' } }, mcp('tm8_act', { data: { ok: true } })),
    ),
  ];

  it('docs, artifacts and drawings show a thumbnail and their size; the row (thumbnail included) opens them', () => {
    const onOpenEntity = vi.fn();
    const view = render(<Transcript turns={content()} onOpenEntity={onOpenEntity} />);
    const byKind = (kind: string) => view.getAllByTestId('chat-ledger-create').find((row) => row.dataset.kind === kind)!;
    const doc = byKind('doc');
    expect(within(doc).getByTestId('chat-receipt-thumb').dataset.kind).toBe('doc');
    expect(doc.querySelector('.tch-rrow__line')!.textContent).toBe('The provider wraps the docker socket.');
    expect(within(doc).getByTestId('chat-receipt-meta').textContent).toBe('doc · 47 words');
    const art = byKind('artifact');
    expect(art.querySelector('.tch-rrow__line')!.textContent).toBe('Before and after, desktop and phone');
    expect(within(art).getByTestId('chat-receipt-meta').textContent).toBe('artifact · 2 files');
    const draw = byKind('drawing');
    expect(draw.querySelectorAll('svg rect, svg ellipse, svg line')).toHaveLength(3);
    expect(within(draw).getByTestId('chat-receipt-meta').textContent).toContain('drawing · 2 shapes · 1 connector');
    fireEvent.click(within(doc).getByTestId('chat-receipt-thumb'));
    expect(onOpenEntity).toHaveBeenCalledWith(DOC);
    // A task keeps its glyph: there is nothing inside it to preview.
    expect(within(byKind('task')).queryByTestId('chat-receipt-thumb')).toBeNull();
  });

  it('edges render: a produced or attached entity nests under its task; another link is said on its row', () => {
    const view = render(<Transcript turns={content()} />);
    const rows = rowsIn(view.container);
    expect(rows.map((row) => [row.dataset.kind, row.dataset.depth ?? '0'])).toEqual([
      ['task', '0'],
      ['doc', '1'], // attachTo
      ['artifact', '1'], // produces
      ['drawing', '0'],
    ]);
    expect(within(rows[3]!).getByTestId('chat-receipt-meta').textContent).toContain('depends on Containers P1 — docker provider');
    // The link calls are rows, not step lines.
    expect(view.queryAllByTestId('chat-step-line')).toHaveLength(0);
  });
});

describe('the cap, pending rows, and entrance', () => {
  it('past six rows shows five and says what the rest are', () => {
    const many = turn(...Array.from({ length: 8 }, (_, i) => createTask(id(60 + i), `Task ${i}`, null)));
    const view = render(<Transcript turns={[many]} />);
    expect(rowsIn(view.container)).toHaveLength(5);
    const more = view.getByTestId('chat-receipt-more');
    expect(more.textContent).toBe('+3 more: 3 tasks ▸');
    fireEvent.click(more);
    expect(rowsIn(view.container)).toHaveLength(8);
    expect(view.queryByTestId('chat-receipt-more')).toBeNull();
  });

  it('a running create is a pending row that becomes the real row IN PLACE', () => {
    const settled = createTask(P1, 'Containers P1 — docker provider', null);
    const running = [{ ...settled[0]!, state: 'running' } as ChatTurnPart];
    const t = turn(running);
    const view = render(<Transcript turns={[t]} />);
    const pending = rowsIn(view.container)[0]!;
    expect(pending.dataset.mark).toBe('pending');
    expect(titleOf(pending)).toBe('Creating task “Containers P1 — docker provider”');
    view.rerender(<Transcript turns={[{ ...t, parts: settled }]} />);
    const real = rowsIn(view.container)[0]!;
    expect(real.dataset.mark).toBe('made');
    expect(real).toBe(pending);
  });

  it('history renders still; a row that ARRIVES rises once; a remount does not replay it', () => {
    const [first, second] = fixtureThread();
    const rising = (view: ReturnType<typeof render>) => view.container.querySelectorAll('.tch-rrow[data-enter]').length;
    const view = render(<Transcript turns={[first!]} onOpenEntity={vi.fn()} />);
    expect(rowsIn(view.container)).toHaveLength(3);
    expect(rising(view)).toBe(0);
    // Turn 2 streams in: its three rows rise, turn 1's do not.
    view.rerender(<Transcript turns={[first!, second!]} onOpenEntity={vi.fn()} />);
    expect(rising(view)).toBe(3);
    view.rerender(<Transcript turns={[first!, second!]} onOpenEntity={vi.fn()} generation={1} />);
    expect(rising(view)).toBe(0);
    view.rerender(<Transcript turns={[first!, second!]} onOpenEntity={vi.fn()} thread="thread-2" />);
    expect(rising(view)).toBe(0);
  });
});

describe('ids in the prose are entity chips', () => {
  it('a code span that IS an id renders as a chip titled from the fold; other code stays code', () => {
    const onOpenEntity = vi.fn();
    const t = turn(
      createTask(P1, 'Containers P1 — docker provider', null),
      [{ kind: 'text', seq: (seq += 1), text: `Made \`${P1}\` — run \`bun test\`, and see \`${MEMORY}\`.` }],
    );
    const view = render(<Transcript turns={[t]} onOpenEntity={onOpenEntity} />);
    const chips = view.getAllByTestId('chat-entity-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toContain('Containers P1 — docker provider');
    fireEvent.click(chips[0]!);
    expect(onOpenEntity).toHaveBeenCalledWith(P1);
    expect(view.getByTestId('chat-turn-text').querySelector('code')!.textContent).toBe('bun test');
    expect(view.getByTestId('chat-turn-text').textContent).not.toContain(P1);
  });
});

/* jsdom loads no stylesheets, so the CSS-only half of the design is pinned
   against the stylesheet SOURCE. */
describe('turn-receipt.css — the rules no render test can see', () => {
  const css = readFileSync(`${process.cwd()}/src/chat-home/turn-receipt.css`, 'utf8');
  const tsx = readFileSync(`${process.cwd()}/src/chat-home/TurnReceipt.tsx`, 'utf8');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));

  it('is imported by the component itself, so every host renders it styled', () => {
    expect(tsx).toContain("import './turn-receipt.css';");
  });

  it('is a tinted block with no border, rail or shadow, and no uppercase anywhere', () => {
    expect(css).toMatch(/\.tch-receipt \{[^}]*background: var\(--pn-surface\);/);
    expect(css).not.toMatch(/border-left: 3px/);
    expect(css).not.toMatch(/box-shadow/);
    expect(css).not.toMatch(/text-transform: uppercase/);
  });

  it('wraps the meta and state under the title in a narrow column (a container query)', () => {
    expect(css).toMatch(/\.tch-receipt \{[^}]*container-type: inline-size;/);
    expect(css).toMatch(/@container \(max-width: 480px\) \{\s*\.tch-rrow \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  });

  it('shows keyboard focus on a row and on a worker pill', () => {
    expect(css).toMatch(/button\.tch-rrow__main:focus-visible \{[^}]*outline: 2px solid var\(--pn-brand\);/);
    expect(css).toMatch(/button\.tch-rpill:focus-visible \{[^}]*outline: 2px solid var\(--pn-brand\);/);
  });

  it('stills the entrance, the live dot and the pending shimmer under reduced motion', () => {
    expect(reduced).toMatch(/\.tch-rrow\[data-enter\],\s*\.tch-rstate\[data-tone='live'\] \.tch-rstate__dot,\s*\.tch-rrow\[data-mark='pending'\] \.tch-rrow__end::after \{\s*animation: none;/);
  });
});
