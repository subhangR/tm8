import { createRoot } from 'react-dom/client';
import type { AttentionRequest, EntityDetail, EntityId, SpaceId } from '@tm8/contract';
import { EntityDetailPanel, type DetailReasons } from '../src/panels';
import { AttentionRequests } from '../src/attention/AttentionRequests';
import type { AttentionPort } from '../src/attention/port';
import { FIXTURE_SPACE_ID, channelDesign, fixtureDetails, sessionExited, taskUuidTitle } from '../src/fixtures';
import type { ActionContext } from '../src/domain';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/shell/shell.css';
import '../src/panels/panels.css';
import '../src/attention/attention.css';

/**
 * A REAL-BROWSER harness for THE ATTENTION DOCK (user ruling 2026-09-07:
 * "taking up too much space at the bottom … collapsible, with a sleek bar at
 * the bottom").
 *
 * WHY PIXELS AND NOT ONLY JSDOM. Every claim this change makes is a layout
 * claim: the bar is PINNED (it does not move when the body scrolls), the sheet
 * lifts OVER the content rather than shortening it, and the collapsed bar is
 * one line rather than four cards. jsdom has no layout, so `position: absolute`,
 * `bottom: 100%` and the whole of `overflow` are inert there — the unit suite
 * can prove the DOM shape and nothing about the geometry.
 *
 *   /e2e/attention-dock-harness.html
 *
 * FIXTURES, NOT A NODE. The port is an array; nothing here writes.
 */
const REASONS: DetailReasons = {
  presenceHollow: 'Presence is not measured yet.',
  versionHistory: 'Version history is deferred.',
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'not in the stamped seam',
  withdrawUnavailable: 'not in the stamped seam',
};

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const ENTITY = 'ent-dock' as EntityId;
const actor = (name: string) =>
  ({ id: `m-${name}`, kind: 'member', displayName: name, avatar: null, role: 'member', isAgent: false }) as never;

function req(over: Partial<AttentionRequest> & { id: string; points: number }): AttentionRequest {
  return {
    spaceId: FIXTURE_SPACE_ID as SpaceId,
    entityId: ENTITY,
    reason: 'because',
    status: 'resolved',
    version: 1,
    requestedBy: actor('tm8 UI Builder'),
    acknowledgedBy: null,
    resolvedBy: actor('Subhang'),
    resolutionNote: null,
    createdAt: '2026-09-07T06:00:00.000Z',
    updatedAt: '2026-09-07T09:00:00.000Z',
    acknowledgedAt: null,
    resolvedAt: '2026-09-07T09:00:00.000Z',
    ...over,
  } as AttentionRequest;
}

/** THE EXACT HISTORY FROM THE REPORT — four settled rows, 85/80/75/70. */
const SETTLED: AttentionRequest[] = [
  req({ id: 'a', points: 85, reason: 'PR #600 ready and gated clean — needs subhangR to merge; only that account may update main' }),
  req({ id: 'b', points: 80, reason: 'PR #600 ready, all gates met, but merge is blocked by branch policy — needs admin (subhangR). Dispatcher has push only.' }),
  req({ id: 'c', points: 75, reason: 'Design is up; two product decisions need Tarkesh: keep or delete the /ui-2.0/ door, and 36→40px bar. Build is paused on his go-ahead.' }),
  req({ id: 'd', points: 70, reason: 'Top bar redesign: artifact + doc published, two decisions needed before build' }),
];

/** The same record with the loudest row still OPEN — the auto-open case. */
const PENDING: AttentionRequest[] = [
  req({ id: 'a', points: 85, status: 'open', resolvedBy: null, resolvedAt: null, reason: 'PR #600 ready and gated clean — needs subhangR to merge; only that account may update main' }),
  ...SETTLED.slice(1),
];

/**
 * A STATEFUL fake port — it answers a settle the way the NODE does.
 *
 * It used to return `{ request: null }`, which was fine while settling only
 * triggered a refetch. It is not fine now: the Undo toast is offered only when
 * the server hands back the written row (that copy carries the bumped `version`
 * an undo has to send), so a null there made the whole affordance invisible in
 * the browser — the one place it can actually be looked at.
 *
 * Still no node and still no network. The point is the SHAPE of the reply.
 */
const portFor = (initial: AttentionRequest[]): AttentionPort => {
  const rows = initial.map((r) => ({ ...r }));
  return {
    history: async () => ({ rows: rows.map((r) => ({ ...r })), truncated: false }),
    settle: async ({ requestId, expectedVersion, status, resolutionNote }) => {
      const i = rows.findIndex((r) => r.id === requestId);
      if (i < 0) throw new Error(`no such request: ${requestId}`);
      const reopened = status === 'open' || status === 'acknowledged';
      const next = {
        ...rows[i]!,
        status,
        version: expectedVersion + 1,
        // Mirrors migration 050: reopening CLEARS the resolution stamp, and the
        // note is coalesced rather than overwritten.
        resolvedBy: reopened ? null : actor('Subhang'),
        resolvedAt: reopened ? null : '2026-09-07T14:00:00.000Z',
        ...(resolutionNote ? { resolutionNote } : {}),
      } as AttentionRequest;
      rows[i] = next;
      return { request: { ...next }, entity: { id: ENTITY } as never, affectedCount: 1 };
    },
  };
};

const FILLER =
  'The panel is a fixed anatomy: header, tab row, controls band, body, footer. ' +
  'Only the body varies, and only by archetype.';
const BODY = Array.from({ length: 12 }, (_, i) =>
  [`## Section ${i + 1}`, '', FILLER, '', FILLER, ''].join('\n'),
).join('\n');

const DOC = {
  ...fixtureDetails['doc-layout-spec'],
  id: 'doc-dock',
  kind: 'doc',
  title: 'Chat UI — The Entity Ledger and the Sticky Projection',
  state: { kind: 'doc', format: 'markdown', childCount: 0 },
  content: { kind: 'doc', body: BODY, format: 'markdown' },
} as unknown as EntityDetail;

const TASK = fixtureDetails[taskUuidTitle.id]!;
/* THE TWO ARCHETYPES THAT USED TO BE EXILED, and the pixel evidence for the
   ruling that ended it. A work session is `archetype: 'terminal'` — a live PTY
   owning its full height — and a channel is `composition: 'chat'`, a body that
   ends at its composer. Neither could spare four cards of history, so the old
   section was pushed onto their Connections tab; both can spare one line.

   `sessionExited` rather than `sessionLive`, for two reasons: only the exited
   one has a `fixtureDetails` entry, and a terminal with no PTY behind it paints
   deterministically instead of waiting on a socket that this harness has no
   node to open. */
const SESSION = fixtureDetails[sessionExited.id]!;
const CHANNEL = fixtureDetails[channelDesign.id]!;

function Case({ label, detail, rows, testid }: {
  label: string; detail: EntityDetail; rows: AttentionRequest[]; testid: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-case={testid}>
      <div style={{ font: '600 11px ui-monospace, monospace', color: 'var(--pn-ink-3)' }}>{label}</div>
      <div style={{ width: 620, height: 560, display: 'flex' }} data-panel-box={testid}>
        <EntityDetailPanel
          detail={detail}
          reasons={REASONS}
          ctx={ctx}
          onClose={() => {}}
          onPromote={() => {}}
          attentionSection={
            <AttentionRequests entityId={ENTITY} port={portFor(rows)} now="2026-09-07T14:00:00.000Z" />
          }
        />
      </div>
    </div>
  );
}

const params = new URLSearchParams(location.search);

function Harness() {
  return (
    <div
      className="cv2-root"
      data-theme={params.get('theme') === 'dark' ? 'dark' : 'light'}
      style={{
        background: 'var(--pn-paper)',
        padding: 16,
        display: 'flex',
        gap: 16,
        alignItems: 'flex-start',
        minHeight: '100vh',
      }}
    >
      <Case label="doc — 4 settled, collapsed by default" detail={DOC} rows={SETTLED} testid="settled" />
      <Case label="task — 1 waiting, opens itself" detail={TASK} rows={PENDING} testid="pending" />
      <Case label="work_session (terminal) — the exile is over" detail={SESSION} rows={SETTLED} testid="session" />
      <Case label="channel (composition:chat) — likewise" detail={CHANNEL} rows={PENDING} testid="channel" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
