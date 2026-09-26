import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import './kit/kit.css';
import './chat-home/chat-home.css';
import type { EntityDetail, EntityId } from '@tm8/contract';
import type { SessionLiveness } from './data/seam';
import { buildChatLedger } from './chat-home/ledger';
import { LedgerHostProvider, type LedgerHost } from './chat-home/LedgerCards';
import { TurnParts } from './chat-home/TurnParts';
import type { ChatTurn, ChatTurnPart } from './chat-home/types';

/**
 * CHAT LEDGER CARDS SCRATCH HARNESS (lane 4) — a gate-free mount of the
 * transcript's ledger rendering, over a fixture thread shaped like this node's
 * real transcripts, so a browser can answer what jsdom cannot: does a created
 * card READ as the highlight (rail, mark, tag), do consecutive creates stack as
 * one group, do the four session tags and the transition pills look right, and
 * do the reads stay quiet beside them.
 *
 * Open /ledger-cards-dev.html on a vite dev server for this package. Each
 * spawned session is shown in one of the four states the seam can report.
 */

const id = (n: number): string => `01a0dc90-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PROGRAM = id(1);
const P1 = id(2);
const C1 = id(3);
const C2 = id(4);
const DOC = id(10);
const SESSIONS = { live: id(5), waiting: id(11), done: id(12), failed: id(13) } as const;
const MEMORY = id(6);

let seq = 0;
let turnNo = 0;
function call(name: string, args: unknown, result: unknown, state: 'completed' | 'error' = 'completed'): ChatTurnPart[] {
  const toolCallId = `tc-${(seq += 1)}`;
  return [
    { kind: 'tool_call', seq: (seq += 1), toolCallId, name, args, state },
    { kind: 'tool_result', seq: (seq += 1), toolCallId, content: result, ...(state === 'error' ? { isError: true } : {}) },
  ];
}
function text(body: string): ChatTurnPart[] {
  return [{ kind: 'text', seq: (seq += 1), text: body }];
}
function turn(...parts: ChatTurnPart[][]): ChatTurn {
  return { messageId: `msg-${(turnNo += 1)}` as EntityId, role: 'assistant', author: null, createdAt: '', body: '', parts: parts.flat() };
}
const mcp = (tool: string, payload: Record<string, unknown>) => JSON.stringify({ schemaVersion: 'tm8.mcp.result.v1', tool, ...payload });
const receipt = (fields: Record<string, unknown>) => ({ schemaVersion: 'tm8.receipt.v1', ok: true, ...fields });
const createTask = (entityId: string, title: string, parentId: string | null) =>
  call('mcp__tm8__tm8_act', { operation: 'entities.create', body: { spaceId: 'sp', kind: 'task', title, parentId } },
    mcp('tm8_act', { data: receipt({ op: 'entity.create', id: entityId, kind: 'task', title, parentId, status: { to: 'open' } }) }));
const spawn = (sessionId: string, title: string) =>
  call('mcp__tm8__tm8_delegate', { operation: 'execution.spawn', body: { teamMemberId: id(9), taskIds: [P1], mode: 'coordinated-worker' } },
    mcp('tm8_delegate', { data: { entity: { id: sessionId, kind: 'work_session', title, state: { kind: 'work_session', status: 'running', model: 'claude-opus-5-5' } } } }));

export const THREAD: ChatTurn[] = [
  turn(
    text('Breaking P1 into tasks under the Containers program.'),
    call('mcp__tm8__tm8_read', { operation: 'collections.query', body: { kinds: ['task'] } },
      mcp('tm8_read', { data: { items: [
        { id: id(20), kind: 'task', title: 'gVisor research', state: { kind: 'task', status: 'working' } },
        { id: id(21), kind: 'doc', title: 'utho host facts' },
        { id: id(22), kind: 'task', title: 'Containers P0', state: { kind: 'task', status: 'done' } },
      ] } })),
    createTask(P1, 'Containers P1 — docker provider', PROGRAM),
    createTask(C1, 'Provider interface', P1),
    createTask(C2, 'Docker socket lifecycle', P1),
    call('mcp__tm8__memory_write', { spaceId: 'sp', statement: 'Spawn, do not dispatch' },
      mcp('memory_write', { data: { entity: { id: MEMORY, kind: 'memory', title: 'Spawn, do not dispatch' } } })),
    text('Created P1 with two children, and noted the routing rule.'),
  ),
  turn(
    text('Starting work and spawning workers.'),
    call('mcp__tm8__tm8_act', { operation: 'entities.commands.work', params: { id: C2 }, body: { status: 'working' } },
      mcp('tm8_act', { data: receipt({ op: 'task.transition', id: C2, kind: 'task', status: { from: 'open', to: 'working' }, changed: ['state.status'] }) })),
    call('mcp__tm8__tm8_act', { operation: 'entities.commands.complete', params: { id: C1 }, body: { expectedVersion: 1 } },
      JSON.stringify({ schemaVersion: 'tm8.mcp.error.v1', error: { code: 'acceptance_incomplete', message: 'unticked criteria' } }), 'error'),
    spawn(SESSIONS.live, 'Worker · provider interface'),
    spawn(SESSIONS.waiting, 'Reviewer · P1 tasks'),
    spawn(SESSIONS.done, 'Worker · socket lifecycle'),
    spawn(SESSIONS.failed, 'Worker · gVisor flag'),
  ),
  turn(
    call('mcp__tm8__tm8_act', { operation: 'entities.commands.complete', params: { id: C2 }, body: { expectedVersion: 2 } },
      mcp('tm8_act', { data: receipt({ op: 'task.complete', id: C2, kind: 'task', status: { to: 'done' } }) })),
    call('mcp__tm8__tm8_act', { operation: 'entities.commands.tick', params: { id: C1 }, body: { criterionIds: ['c1'] } },
      mcp('tm8_act', { data: receipt({ op: 'task.tick', id: C1, kind: 'task', changed: ['content.acceptanceCriteria'] }) })),
    text('Socket lifecycle is done; ticked the provider interface criteria.'),
  ),
];

const STATUS: Record<string, [string, SessionLiveness]> = {
  [SESSIONS.live]: ['running', 'live'],
  [SESSIONS.waiting]: ['idle', 'live'],
  [SESSIONS.done]: ['exited', 'not-running'],
  [SESSIONS.failed]: ['failed', 'not-running'],
};
export const HOST: LedgerHost = {
  resolveEntity: async (entityId) =>
    entityId === PROGRAM ? { id: PROGRAM, kind: 'task', title: 'Containers program' } : { id: entityId },
  readEntity: async (entityId) =>
    ({ id: entityId, kind: 'work_session', title: 'Session', state: { kind: 'work_session', status: STATUS[entityId]?.[0] ?? 'running' } }) as unknown as EntityDetail,
  livenessOf: ({ id: sessionId }) => STATUS[sessionId]?.[1] ?? 'unknown',
  models: [{ model: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'anthropic', agentTool: 'claude-code' }],
};
void DOC;

export function Column({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section style={{ flex: '1 1 0', minWidth: 0, padding: 20, background: 'var(--pn-paper)' }}>
      <h2 style={{ font: '600 11px/1 var(--pn-ui)', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--pn-ink-3)', margin: '0 0 12px' }}>{label}</h2>
      {children}
    </section>
  );
}

export function AfterTranscript() {
  const ledger = buildChatLedger(THREAD);
  return (
    <LedgerHostProvider {...HOST}>
      {THREAD.map((t) => (
        <article key={t.messageId} className="tch-turn" data-role="assistant" style={{ marginBottom: 18 }}>
          <TurnParts parts={t.parts} ledger={ledger} turnMessageId={t.messageId} onOpenEntity={(opened) => console.log('open', opened)} resolveEntity={HOST.resolveEntity} />
        </article>
      ))}
    </LedgerHostProvider>
  );
}

/* The BEFORE column exists only while a reviewer has dropped main's
   `TurnParts`/`ledger` in beside this file as `chat-home/__before_*`; the
   committed harness shows the current rendering alone. */
const befores = import.meta.glob('./chat-home/__before_TurnParts.tsx', { eager: true }) as Record<string, { TurnParts: typeof TurnParts }>;
const beforeLedgers = import.meta.glob('./chat-home/__before_ledger.ts', { eager: true }) as Record<string, { buildChatLedger: typeof buildChatLedger }>;
const Before: typeof TurnParts | undefined = Object.values(befores).at(0)?.TurnParts;
const beforeFold: typeof buildChatLedger | undefined = Object.values(beforeLedgers).at(0)?.buildChatLedger;

function App() {
  return (
    <div className="cv2-root" style={{ display: 'flex', gap: 1, background: 'var(--pn-line)', minHeight: '100vh' }}>
      {Before && beforeFold ? (
        <Column label="Before — main">
          {THREAD.map((t) => (
            <article key={t.messageId} className="tch-turn" data-role="assistant" style={{ marginBottom: 18 }}>
              <Before parts={t.parts} ledger={beforeFold(THREAD) as never} turnMessageId={t.messageId} onOpenEntity={() => undefined} />
            </article>
          ))}
        </Column>
      ) : null}
      <Column label="After — lane 4">
        <AfterTranscript />
      </Column>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
