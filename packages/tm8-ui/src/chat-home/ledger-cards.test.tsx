// @vitest-environment jsdom
/**
 * LANE 4 ACCEPTANCE — what the chat MADE is highlighted, exactly once; what it
 * READ is not; the highlight opens the thing it names, from the keyboard too.
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
import {
  LedgerHostProvider,
  SESSION_VERDICT_TICK_MS,
  resetLedgerCardEntrances,
  type LedgerHost,
} from './LedgerCards';
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
}: {
  turns: ChatTurn[];
  host?: LedgerHost;
  onOpenEntity?: (id: EntityId) => void;
}) {
  const ledger = buildChatLedger(turns);
  return (
    <LedgerHostProvider {...host}>
      {turns.map((t) => (
        <article key={t.messageId} data-testid="turn">
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
  resetLedgerCardEntrances();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the fixture thread — every create, spawn and transition highlighted exactly once', () => {
  it('draws one card per created id across the whole thread, and none for reads', () => {
    const onOpenEntity = vi.fn();
    const view = render(<Transcript turns={fixtureThread()} onOpenEntity={onOpenEntity} />);

    const cards = view.getAllByTestId('chat-ledger-create');
    // P1, C1, C2, the session, the memory — P1's replay in turn 3 is NOT a card.
    expect(cards).toHaveLength(5);
    cards.forEach((card) => fireEvent.click(within(card).getByRole('button')));
    expect(onOpenEntity.mock.calls.map(([opened]) => opened)).toEqual([P1, C1, C2, SESSION, MEMORY]);

    // Exactly one spawned card, and it is the session.
    const spawned = cards.filter((card) => card.dataset.variant === 'spawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.textContent).toContain('Worker · provider interface');

    // Turn 3 holds the replay and the memory: only the memory is a card.
    const turns = view.getAllByTestId('turn');
    expect(within(turns[2]!).getAllByTestId('chat-ledger-create')).toHaveLength(1);
    expect(within(turns[2]!).getByTestId('chat-ledger-create').dataset.kind).toBe('memory');

    // Reads stay the quiet counted sentence — never a card, never highlighted.
    expect(view.getAllByTestId('chat-ledger-reads')).toHaveLength(2);
    const carded = cards.map((card) => card.textContent ?? '').join(' | ');
    expect(carded).not.toContain('Existing A');
    expect(carded).not.toContain('Existing B');
    expect(within(turns[3]!).queryByTestId('chat-ledger-create')).toBeNull();
  });

  it('draws each caused transition once, from the server’s own from-side, and nothing for a refusal', () => {
    const view = render(<Transcript turns={fixtureThread()} />);
    const rows = view.getAllByTestId('chat-ledger-transition');
    expect(rows).toHaveLength(2);
    const pills = rows.map((row) =>
      [...row.querySelectorAll('.tch-ltrans__pill')].map((pill) => `${(pill as HTMLElement).dataset.side}:${pill.textContent}`),
    );
    expect(pills).toEqual([
      ['from:open', 'to:working'],
      ['from:working', 'to:done'],
    ]);
    // The `done` pill takes the finished tone; `working` does not.
    expect(rows[1]!.querySelector('[data-side="to"]')!.hasAttribute('data-done')).toBe(true);
    expect(rows[0]!.querySelector('[data-side="to"]')!.hasAttribute('data-done')).toBe(false);
    // The refused complete on C1 (turn 2) drew nothing at all.
    expect(rows.map((row) => row.textContent)).not.toContainEqual(expect.stringContaining('Provider interface'));
  });

  it('says where each create landed — under its parent, created here or not', async () => {
    const resolveEntity = vi.fn(async (entityId: EntityId) =>
      entityId === PROGRAM ? { id: PROGRAM, kind: 'task', title: 'Containers program' } : { id: entityId },
    );
    const view = render(<Transcript turns={fixtureThread()} host={{ resolveEntity }} />);
    const [p1, c1] = view.getAllByTestId('chat-ledger-create');
    // A parent created in this thread is named from the fold, synchronously.
    expect(c1!.textContent).toContain('New task · under Containers P1 — docker provider');
    // A parent the thread never read resolves lazily through the chips' cache —
    // standing in as its kind, never as an id, until it does.
    await vi.waitFor(() => expect(p1!.textContent).toContain('New task · under Containers program'));
    expect(resolveEntity).toHaveBeenCalledWith(PROGRAM);
    expect(view.container.textContent).not.toContain(PROGRAM.slice(0, 8));
  });

  it('draws the turn’s non-status edits as ONE quiet line, never a card', () => {
    const view = render(<Transcript turns={fixtureThread()} />);
    const edit = view.getByTestId('chat-ledger-edit');
    expect(edit.textContent).toBe('✎ Edited Provider interface (acceptance criteria)');
    expect(edit.closest('.tch-lcard')).toBeNull();
  });
});

describe('cards are keyboard-openable', () => {
  it('each card is a native button in the tab order, so Enter and Space open it', () => {
    const view = render(<Transcript turns={fixtureThread()} onOpenEntity={vi.fn()} />);
    for (const card of view.getAllByTestId('chat-ledger-create')) {
      const button = within(card).getByRole('button');
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.tabIndex).toBe(0);
      expect(button.hasAttribute('disabled')).toBe(false);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it('with no opener the card is inert — no dead button', () => {
    const view = render(<Transcript turns={fixtureThread()} />);
    expect(view.getAllByTestId('chat-ledger-create')).toHaveLength(5);
    expect(view.container.querySelector('button.tch-lcard')).toBeNull();
  });
});

describe('a spawned session shows its live status — and no tag rather than a guess', () => {
  const spawnOnly = (): ChatTurn[] => [fixtureThread()[1]!];

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

  it('LIVE only from the seam’s live verdict, with the model’s catalog name', async () => {
    const view = render(<Transcript turns={spawnOnly()} host={hostWith(async () => sessionDetail('running'), () => 'live')} />);
    await vi.waitFor(() => expect(tagOf(view)).toBe('Live'));
    expect(view.getByTestId('chat-ledger-session-status').querySelector('.tch-lcard__dot')).not.toBeNull();
    expect(view.getByTestId('chat-ledger-create').textContent).toContain('Spawned session · Opus 5.5');
  });

  it('WAITING when live but idle; DONE when exited; FAILED when failed', async () => {
    const cases: Array<[string, SessionLiveness, string]> = [
      ['idle', 'live', 'Waiting'],
      ['exited', 'not-running', 'Done'],
      ['failed', 'not-running', 'Failed'],
    ];
    for (const [status, liveness, word] of cases) {
      resetFleetEntityCache();
      const view = render(<Transcript turns={spawnOnly()} host={hostWith(async () => sessionDetail(status), () => liveness)} />);
      await vi.waitFor(() => expect(tagOf(view)).toBe(word));
      view.unmount();
    }
  });

  it('no tag while the read is unresolved, none without a host, none for a stale record', async () => {
    const pending = render(<Transcript turns={spawnOnly()} host={hostWith(() => new Promise(() => {}), () => 'live')} />);
    expect(tagOf(pending)).toBeNull();
    pending.unmount();

    const bare = render(<Transcript turns={spawnOnly()} />);
    expect(tagOf(bare)).toBeNull();
    expect(bare.getByTestId('chat-ledger-create').textContent).toContain('Spawned session');
    bare.unmount();

    // `running` per record, no live process (a node restart): none of the
    // four words is true of it.
    resetFleetEntityCache();
    const stale = render(<Transcript turns={spawnOnly()} host={hostWith(async () => sessionDetail('running'), () => 'stale')} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(tagOf(stale)).toBeNull();
  });

  it('a session that ENDS after the turn goes from Live to Done on a quiet screen', async () => {
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
    expect(tagOf(view)).toBe('Live');

    // The worker exits. Nothing re-renders the transcript — only the tick.
    live = false;
    recorded = 'exited';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_VERDICT_TICK_MS);
    });
    expect(tagOf(view)).toBe('Done');
    // One shared read, one re-read on the verdict change — not one per tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SESSION_VERDICT_TICK_MS * 3);
    });
    expect(readEntity).toHaveBeenCalledTimes(2);
  });
});

describe('titles on first paint, entrance once', () => {
  it('a create names itself from its own args on the FIRST render, with no resolver', () => {
    const view = render(<Transcript turns={[fixtureThread()[0]!]} />);
    const titles = view.getAllByTestId('chat-ledger-create').map((card) => card.querySelector('.tch-lcard__title')!.textContent);
    expect(titles).toEqual(['Containers P1 — docker provider', 'Provider interface', 'Docker socket lifecycle']);
  });

  it('rises on first mount only — a remount (a regrouped run, a re-read thread) does not replay it', () => {
    const first = render(<Transcript turns={[fixtureThread()[0]!]} onOpenEntity={vi.fn()} />);
    const entering = first.container.querySelectorAll('.tch-lcard[data-enter]');
    expect(entering).toHaveLength(3);
    first.unmount();
    const again = render(<Transcript turns={[fixtureThread()[0]!]} onOpenEntity={vi.fn()} />);
    expect(again.container.querySelectorAll('.tch-lcard[data-enter]')).toHaveLength(0);
  });
});

/* jsdom loads no stylesheets, so the CSS-only half of the design is pinned
   against the stylesheet SOURCE. Each assertion names a rule whose absence
   would pass every render test above. */
describe('ledger-cards.css — the rules no render test can see', () => {
  /* From the CWD, not `import.meta.url` — under jsdom that URL is http. */
  const css = readFileSync(`${process.cwd()}/src/chat-home/ledger-cards.css`, 'utf8');
  const tsx = readFileSync(`${process.cwd()}/src/chat-home/LedgerCards.tsx`, 'utf8');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));

  it('is imported by the component itself, so every host renders it styled', () => {
    expect(tsx).toContain("import './ledger-cards.css';");
  });

  it('draws the brand rail for a create and the run rail for a spawn', () => {
    expect(css).toMatch(/\.tch-lcard \{[^}]*border-left: 3px solid var\(--pn-brand\);/);
    expect(css).toMatch(/\.tch-lcard\[data-variant='spawned'\] \{[^}]*border-left-color: var\(--pn-run\);/);
  });

  it('stacks consecutive card blocks into one group', () => {
    expect(css).toMatch(/\.tch-ledger:has\(> \.tch-created\) \+ \.tch-ledger:has\(> \.tch-created\) \{[^}]*margin-top: -4px;/);
  });

  it('shows keyboard focus on the card', () => {
    expect(css).toMatch(/button\.tch-lcard:focus-visible \{[^}]*outline: 2px solid var\(--pn-brand\);[^}]*outline-offset: 2px;/);
  });

  it('stills the entrance and the live dot under reduced motion', () => {
    expect(reduced).toMatch(/\.tch-lcard\[data-enter\] \{\s*animation: none;/);
    expect(reduced).toMatch(/\.tch-lcard__dot \{\s*animation: none;/);
  });
});
