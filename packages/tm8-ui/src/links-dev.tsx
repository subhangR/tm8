/**
 * Scratch harness for the Links (Connections) tab — `links-dev.html`.
 *
 * Renders `ConnectionsTab` with a made-up but realistic network, in the light
 * theme and the dark one side by side, so the tab can be looked at (and
 * screenshotted headlessly) without a server, a session or a terminal. The
 * fixture here is the same shape the unit tests build; nothing in it is wired
 * to the app. `?cursor=1` paints the keyboard cursor on the second row;
 * `?view=timeline` opens the Timeline reading, `?compact=1` the compact Links.
 */
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { fixtureDetails } from './fixtures';
import { ConnectionsTab } from './panels/detail/tabs';

const base = Object.values(fixtureDetails).find((d) => d.deletedAt == null)! as EntityDetail;
const self = { ...base, id: 'self' } as EntityDetail;

function peer(id: string, kind: EntitySummary['kind'], title: string, state?: Record<string, unknown>): EntitySummary {
  return { ...(self as unknown as EntitySummary), id, kind, title, state: { kind, ...state } as never };
}

function group(
  type: string,
  direction: 'outgoing' | 'incoming',
  edges: { id: string; peer: EntitySummary; at: string; hard?: boolean; resolved?: boolean }[],
) {
  return {
    type,
    label: type,
    direction,
    edges: edges.map((e) => ({
      id: e.id,
      type,
      props: {},
      hard: e.hard,
      resolved: e.resolved,
      createdBy: self.createdBy,
      createdAt: e.at,
      updatedAt: e.at,
      ...(direction === 'outgoing'
        ? { source: self as unknown as EntitySummary, target: e.peer }
        : { source: e.peer, target: self as unknown as EntitySummary }),
    })),
  } as unknown as EntityDetail['connections']['outgoing'][number];
}

const today = new Date();
const at = (daysAgo: number, h: number, m: number) => {
  const d = new Date(today);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const task = peer('p-task', 'task', 'MCP 9/10 — Docs and field guide entry', { status: 'open' });
const coord = peer('p-coord', 'work_session', 'Coordinate full MCP entity, credentials, task integration and UI implementation', { status: 'idle' });
const s2 = peer('p-s2', 'work_session', 'MCP 2/10 — The `mcp_server` entity kind', { status: 'exited' });
const run = peer('p-run', 'work_session', 'MCP 6/10 — implementation run', { status: 'running' });
const mate = peer('p-mate', 'team_member', 'GPT 6 Astra Teammate');
const pr = peer('p-pr', 'pull_request', 'feat(mcp): credential reference, never a token', { number: 1101, state: 'open', ciStatus: 'passing' });
const commit = peer('p-commit', 'commit', 'fix(mcp): redact the token in launch logs', { sha: '3f2a9c1d00', message: '' });
const doc = peer('p-doc', 'doc', 'MCP credential model — design note');
const shot = peer('p-shot', 'file', 'Screenshot 2026-10-07 at 1.38.37 PM.png');
const dep = peer('p-dep', 'task', 'MCP 5/10 — Space credential store', { status: 'working' });
const met = peer('p-met', 'task', 'MCP 4/10 — Credential schema and migration', { status: 'done' });
const next = peer('p-next', 'task', 'MCP 7/10 — Session launch reads the credential reference', { status: 'open' });

const detail: EntityDetail = {
  ...self,
  id: 'self',
  title: 'MCP 6/10 — Credential reference',
  hierarchy: {
    ...self.hierarchy,
    parent: { id: 'p-coord', kind: 'work_session', title: coord.title } as never,
    children: { ...self.hierarchy.children, items: [] },
  },
  connections: {
    outgoing: [
      group('relates_to', 'outgoing', [{ id: 'e1', peer: task, at: at(0, 0, 31) }]),
      group('tracks', 'outgoing', [{ id: 'e2', peer: pr, at: at(0, 8, 42) }]),
      group('depends_on', 'outgoing', [
        { id: 'e3', peer: dep, at: at(2, 1, 12), hard: true, resolved: false },
        { id: 'e3b', peer: met, at: at(2, 1, 10), hard: true, resolved: true },
      ]),
      group('tracks', 'outgoing', [{ id: 'e2b', peer: commit, at: at(2, 9, 15) }]),
      group('produces', 'outgoing', [{ id: 'e2c', peer: doc, at: at(1, 17, 5) }]),
      group('messaged', 'outgoing', [
        { id: 'e4', peer: s2, at: at(2, 1, 39) },
        { id: 'e5', peer: coord, at: at(2, 1, 38) },
      ]),
    ],
    incoming: [
      group('messaged', 'incoming', [
        { id: 'e6', peer: s2, at: at(2, 1, 40) },
        { id: 'e7', peer: coord, at: at(2, 1, 41) },
      ]),
      group('participates_in', 'incoming', [{ id: 'e8', peer: mate, at: at(2, 1, 37) }]),
      group('attached_to', 'incoming', [{ id: 'e9', peer: shot, at: at(0, 13, 38) }]),
      group('depends_on', 'incoming', [{ id: 'e11', peer: next, at: at(1, 11, 20) }]),
      group('working_on', 'incoming', [{ id: 'e12', peer: run, at: at(0, 9, 2) }]),
    ],
    unresolvedHardDependencyCount: 1,
  },
} as unknown as EntityDetail;

function Column({ theme }: { theme?: 'dark' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const press = (name: string) =>
      [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === name)?.click();
    if (params.get('view') === 'timeline') press('Timeline');
    if (params.has('compact')) press('Compact');
    if (!params.has('cursor')) return;
    const list = ref.current?.querySelector<HTMLElement>('[data-testid="pn-peers-list"]');
    list?.focus();
    list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  }, []);
  return (
    <div
      ref={ref}
      className="cv2-root"
      data-theme={theme}
      style={{ width: 860, minHeight: 980, background: 'var(--pn-surface)', color: 'var(--pn-ink)', display: 'flex', flexDirection: 'column' }}
    >
      <ConnectionsTab detail={detail} onOpenEntity={(id) => console.log('open', id)} onOpenDiscussion={() => {}} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <div style={{ display: 'flex', gap: 24, padding: 24, background: '#888', alignItems: 'flex-start' }}>
    <Column />
    <Column theme="dark" />
  </div>,
);
