import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import './kit/kit.css';
import './chat-home/chat-home.css';
import type { EntityDetail, EntityId } from '@tm8/contract';
import type { SessionLiveness } from './data/seam';
import { buildChatLedger } from './chat-home/ledger';
import { LedgerHostProvider, type LedgerHost } from './chat-home/ledger-host';
import { TurnParts } from './chat-home/TurnParts';
import type { ChatTurn, ChatTurnPart } from './chat-home/types';

/**
 * CHAT TURN RECEIPT SCRATCH HARNESS — a gate-free mount of the transcript's
 * receipt (TurnReceipt.tsx) over fixture turns shaped like this node's real
 * transcripts, at desktop (720px) and phone (390px) widths, in the light
 * `chatgpt` style the mockups (artifact 01a14a8c) were drawn in. A browser
 * answers what jsdom cannot: does one row per entity read at a glance, do
 * the state slot's colours match, does the phone wrap hold.
 *
 * Open /turn-receipt-dev.html on a vite dev server for this package.
 *   1. the screenshot case: a task, and a worker spawned on it;
 *   2. a busy turn: doc, artifact, drawing, memory, a status move, edits,
 *      links, and one failed write the agent retried;
 *   3. live states: every session verdict, a pending write and a refusal;
 *   4. a long turn the receipt caps.
 */

const id = (n: number): string => `01a14a83-0610-72b9-b81b-${String(n).padStart(12, '0')}`;

let seq = 0;
let turnNo = 0;
type Outcome = 'completed' | 'error' | 'running';
function call(name: string, args: unknown, result: unknown, state: Outcome = 'completed'): ChatTurnPart[] {
  const toolCallId = `tc-${(seq += 1)}`;
  const parts: ChatTurnPart[] = [{ kind: 'tool_call', seq: (seq += 1), toolCallId, name, args, state }];
  if (state !== 'running') {
    parts.push({ kind: 'tool_result', seq: (seq += 1), toolCallId, content: result, ...(state === 'error' ? { isError: true } : {}) });
  }
  return parts;
}
function text(body: string): ChatTurnPart[] {
  return [{ kind: 'text', seq: (seq += 1), text: body }];
}
function done(): ChatTurnPart[] {
  return [{ kind: 'done', seq: (seq += 1) } as ChatTurnPart];
}
function turn(...parts: ChatTurnPart[][]): ChatTurn {
  return { messageId: `msg-${(turnNo += 1)}` as EntityId, role: 'assistant', author: null, createdAt: '', body: '', parts: parts.flat() };
}
const mcp = (tool: string, payload: Record<string, unknown>) => JSON.stringify({ schemaVersion: 'tm8.mcp.result.v1', tool, ...payload });
const receipt = (fields: Record<string, unknown>) => ({ schemaVersion: 'tm8.receipt.v1', ok: true, ...fields });
const ACT = 'mcp__tm8__tm8_act';
const createTask = (entityId: string, title: string, parentId: string | null = null) =>
  call(ACT, { operation: 'entities.create', body: { spaceId: 'sp', kind: 'task', title, parentId } },
    mcp('tm8_act', { data: receipt({ op: 'entity.create', id: entityId, kind: 'task', title, parentId, status: { to: 'open' } }) }));
const spawn = (sessionId: string, taskId: string, title: string) =>
  call('mcp__tm8__tm8_delegate', { operation: 'execution.spawn', body: { teamMemberId: id(99), taskIds: [taskId], mode: 'coordinated-worker' } },
    mcp('tm8_delegate', { data: { entity: { id: sessionId, kind: 'work_session', title, state: { kind: 'work_session', status: 'running', model: 'claude-opus-5-5' } } } }));
const readTasks = (items: { id: string; title: string; status: string; kind?: string }[]) =>
  call('mcp__tm8__tm8_read', { operation: 'collections.query', body: { kinds: ['task'] } },
    mcp('tm8_read', { data: { items: items.map((it) => ({ id: it.id, kind: it.kind ?? 'task', title: it.title, state: { kind: it.kind ?? 'task', status: it.status } })) } }));
const readFile = (path: string) => call('Read', { file_path: path }, 'file contents');

/* ── 1. the screenshot case ─────────────────────────────────────────────── */
const FIX = id(1);
const FIX_WORKER = id(2);
const S1: ChatTurn[] = [
  turn(
    text('Creating the task for the fix, then starting a worker on it.'),
    readTasks([
      { id: id(3), title: 'New chat: draft survives thread switch', status: 'done' },
      { id: id(4), title: 'Entity tab remount', status: 'working' },
      { id: id(5), title: 'Chat page loading notes', status: 'open', kind: 'doc' },
    ]),
    createTask(FIX, 'New chat: stop the loading page after Send (draft → entity tab remount)'),
    spawn(FIX_WORKER, FIX, 'New chat: stop the loading page after Send (draft → entity tab remount)'),
    text(`I've handed this to a worker. It's running now and will report back here when it's done.\n\n- **Task:** \`${FIX}\`. It includes the root cause I traced, the fix options, and what counts as done.`),
    done(),
  ),
];

/* ── 2. a busy turn ─────────────────────────────────────────────────────── */
const PROPOSAL = id(10);
const AUDIT = id(11);
const MOCKS = id(12);
const DRAWING = id(13);
const MEMORY = id(14);
const S2: ChatTurn[] = [
  turn(
    readTasks([{ id: PROPOSAL, title: 'Proposal: redesign how chat shows created entities, docs, artifacts and drawings', status: 'working' }]),
    readFile('src/chat-home/LedgerCards.tsx'),
    readFile('src/chat-home/TurnParts.tsx'),
    readFile('src/chat-home/turn-steps.ts'),
    call('mcp__tm8__doc_create', {
      spaceId: 'sp', title: 'Chat outcome widgets: audit and proposal', attachTo: PROPOSAL,
      body: '# Chat outcome widgets\n\nThe cards a chat shows for entities the agent creates are big, heavy and repeat themselves.\n\n## Audit\n\n' + 'word '.repeat(1820),
    }, mcp('doc_create', { data: receipt({ op: 'entity.create', id: AUDIT, kind: 'doc', title: 'Chat outcome widgets: audit and proposal' }) })),
    call('mcp__tm8__artifact_create', {
      spaceId: 'sp', name: 'Chat outcome widgets: mockups', description: 'Before vs three directions · desktop + 390px',
      files: [{ path: 'index.html', content: '<!doctype html>' }],
    }, mcp('artifact_create', { data: { entity: { id: MOCKS, kind: 'artifact', title: 'Chat outcome widgets: mockups' } } })),
    call(ACT, { operation: 'entities.create', body: { spaceId: 'sp', kind: 'drawing', title: 'Receipt fold: task → session → doc', content: { kind: 'drawing', elements: [
      { type: 'rectangle', x: 0, y: 40, width: 120, height: 60 },
      { type: 'arrow', x: 120, y: 70, width: 60, height: 0 },
      { type: 'rectangle', x: 180, y: 40, width: 120, height: 60 },
      { type: 'arrow', x: 300, y: 70, width: 60, height: 0 },
      { type: 'ellipse', x: 360, y: 40, width: 120, height: 60 },
    ] } } }, mcp('tm8_act', { data: receipt({ op: 'entity.create', id: DRAWING, kind: 'drawing', title: 'Receipt fold: task → session → doc' }) })),
    call('mcp__tm8__memory_write', { spaceId: 'sp', statement: 'Chat cards stay compact: one row per entity, no pills', mechanism: 'm', subjectScope: 's', doesNotEstablish: 'd' },
      mcp('memory_write', { data: { entity: { id: MEMORY, kind: 'memory' } } })),
    call(ACT, { operation: 'edges.create', body: { srcId: PROPOSAL, dstId: MOCKS, type: 'produces' } }, mcp('tm8_act', { data: { ok: true } })),
    call(ACT, { operation: 'edges.create', body: { srcId: PROPOSAL, dstId: DRAWING, type: 'produces' } }, mcp('tm8_act', { data: { ok: true } })),
    call(ACT, { operation: 'entities.commands.linkPr', params: { id: PROPOSAL }, body: { url: 'https://github.com/x/y/pull/1' } },
      JSON.stringify({ schemaVersion: 'tm8.mcp.error.v1', error: { code: 'version_conflict', message: 'version_conflict' } }), 'error'),
    call(ACT, { operation: 'entities.commands.linkPr', params: { id: PROPOSAL }, body: { url: 'https://github.com/x/y/pull/1' } },
      mcp('tm8_act', { data: receipt({ op: 'task.linkPr', id: PROPOSAL, kind: 'task', changed: ['content.pullRequest'] }) })),
    call(ACT, { operation: 'entities.commands.tick', params: { id: PROPOSAL }, body: { criterionIds: ['c1', 'c2'] } },
      mcp('tm8_act', { data: receipt({ op: 'task.tick', id: PROPOSAL, kind: 'task', changed: ['content.acceptanceCriteria'] }) })),
    call(ACT, { operation: 'entities.commands.work', params: { id: PROPOSAL }, body: { status: 'in_review' } },
      mcp('tm8_act', { data: receipt({ op: 'task.transition', id: PROPOSAL, kind: 'task', status: { from: 'working', to: 'in_review' }, changed: ['state.status'] }) })),
    text('Done. I wrote up the audit, published the mockups and moved the task to review.'),
    done(),
  ),
];

/* ── 3. live states ─────────────────────────────────────────────────────── */
const ST = { todo: id(20), live: id(21), waiting: id(22), done: id(23), crashed: id(24), seeds: id(25), iface: id(26) };
const SS = { live: id(31), waiting: id(32), done: id(33), crashed: id(34), ended: id(35) };
const S3: ChatTurn[] = [
  turn(
    readTasks([
      { id: ST.seeds, title: 'Graph seeds: drop orphan roots', status: 'working' },
      { id: ST.iface, title: 'Provider interface', status: 'working' },
    ]),
    createTask(ST.todo, 'Containers P4: remote provider'),
    createTask(ST.live, 'Fix stale LIVE tag after session exit'),
    spawn(SS.live, ST.live, 'Fix stale LIVE tag after session exit'),
    createTask(ST.waiting, 'Composer: keep draft across thread switch'),
    spawn(SS.waiting, ST.waiting, 'Composer: keep draft across thread switch'),
    createTask(ST.done, 'Ledger: count reads by distinct entity'),
    spawn(SS.done, ST.done, 'Ledger: count reads by distinct entity'),
    createTask(ST.crashed, 'Phone composer: sheet height on rotate'),
    spawn(SS.crashed, ST.crashed, 'Phone composer: sheet height on rotate'),
    spawn(SS.ended, ST.seeds, 'Graph seeds: drop orphan roots'),
    call(ACT, { operation: 'entities.commands.complete', params: { id: ST.iface }, body: { expectedVersion: 3 } },
      JSON.stringify({ schemaVersion: 'tm8.mcp.error.v1', error: { code: 'acceptance_incomplete', message: '2 acceptance criteria are still unticked' } }), 'error'),
    call(ACT, { operation: 'entities.create', body: { spaceId: 'sp', kind: 'task', title: 'Containers P5: firecracker provider' } }, undefined, 'running'),
  ),
];

/* ── 4. a long turn ─────────────────────────────────────────────────────── */
const PROGRAM = id(40);
const S4: ChatTurn[] = [
  turn(
    readTasks([{ id: PROGRAM, title: 'Containers program', status: 'working' }]),
    call(ACT, { operation: 'entities.patch', params: { id: PROGRAM }, body: { content: { kind: 'task', description: 'Four providers.' } } },
      mcp('tm8_act', { data: receipt({ op: 'entity.patch', id: PROGRAM, kind: 'task', changed: ['content.description'] }) })),
    createTask(id(41), 'Containers P1: docker provider', PROGRAM),
    spawn(id(51), id(41), 'Containers P1: docker provider'),
    createTask(id(42), 'Containers P2: firecracker provider', PROGRAM),
    createTask(id(43), 'Containers P3: apple container provider', PROGRAM),
    createTask(id(44), 'Containers P4: remote provider', PROGRAM),
    call('mcp__tm8__doc_create', { spaceId: 'sp', title: 'Provider contract', body: 'The provider interface every backend implements.', attachTo: PROGRAM },
      mcp('doc_create', { data: receipt({ op: 'entity.create', id: id(45), kind: 'doc', title: 'Provider contract' }) })),
    call(ACT, { operation: 'edges.create', body: { srcId: id(42), dstId: id(41), type: 'depends_on' } }, mcp('tm8_act', { data: { ok: true } })),
    text('Broke the containers program into its four providers and put a worker on the first.'),
    done(),
  ),
];

const SESSIONS: Record<string, [string, SessionLiveness, string?]> = {
  [FIX_WORKER]: ['running', 'live'],
  [SS.live]: ['running', 'live'],
  [SS.waiting]: ['idle', 'live'],
  [SS.done]: ['exited', 'not-running', 'completed'],
  [SS.crashed]: ['failed', 'not-running'],
  [SS.ended]: ['exited', 'not-running'],
  [id(51)]: ['idle', 'live'],
};
const TASK_NOW: Record<string, string> = {
  [ST.live]: 'working',
  [ST.waiting]: 'in_review',
  [ST.done]: 'done',
  [ST.crashed]: 'working',
  [FIX]: 'working',
};
export const HOST: LedgerHost = {
  resolveEntity: async (entityId) => ({ id: entityId }),
  readEntity: async (entityId) => {
    const session = SESSIONS[entityId];
    if (session) {
      return { id: entityId, kind: 'work_session', title: 'Session', state: { kind: 'work_session', status: session[0], ...(session[2] ? { outcome: session[2] } : {}) } } as unknown as EntityDetail;
    }
    return { id: entityId, kind: 'task', title: 'Task', state: { kind: 'task', status: TASK_NOW[entityId] ?? 'open' } } as unknown as EntityDetail;
  },
  livenessOf: ({ id: sessionId }) => SESSIONS[sessionId]?.[1] ?? 'unknown',
  models: [{ model: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'anthropic', agentTool: 'claude-code' }],
};

function Thread({ turns }: { turns: ChatTurn[] }) {
  const ledger = buildChatLedger(turns);
  return (
    <>
      {turns.map((t) => (
        <article key={t.messageId} className="tch-turn" data-role="assistant">
          <TurnParts parts={t.parts} ledger={ledger} turnMessageId={t.messageId} onOpenEntity={(opened) => console.log('open', opened)} resolveEntity={HOST.resolveEntity} />
        </article>
      ))}
    </>
  );
}

const SCENARIOS: [string, ChatTurn[]][] = [
  ['1 · create a task, start a worker on it', S1],
  ['2 · a busy turn', S2],
  ['3 · live states', S3],
  ['4 · a long turn', S4],
];

function App() {
  return (
    <div className="cv2-root" data-style="chatgpt" data-theme="light" style={{ padding: 24, background: 'var(--pn-paper)', minHeight: '100vh' }}>
      <LedgerHostProvider {...HOST}>
        {SCENARIOS.map(([label, turns]) => (
          <section key={label} data-scenario={label} style={{ display: 'flex', gap: 24, alignItems: 'flex-start', marginBottom: 32 }}>
            {[720, 390].map((width) => (
              <div key={width} style={{ width, flex: 'none', padding: 20, border: '1px solid var(--pn-line)', borderRadius: 12, background: 'var(--pn-card)' }}>
                <h2 style={{ font: '600 11px/1 var(--pn-mono)', color: 'var(--pn-ink-3)', margin: '0 0 12px' }}>{`${label} · ${width}px`}</h2>
                <Thread turns={turns} />
              </div>
            ))}
          </section>
        ))}
      </LedgerHostProvider>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
