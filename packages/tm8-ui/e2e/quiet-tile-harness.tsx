import { createRoot } from 'react-dom/client';
import type { ActorSummary, EntityCounters, EntitySummary, QueryFilter, StatusCategory } from '@tm8/contract';
import { EntityListPanel } from '../src/panels';
import {
  FIXTURE_SPACE_ID,
  fixtureActors,
  fixtureSummaries,
  sessionExited,
  sessionFailed,
  sessionLive,
  sessionStale,
} from '../src/fixtures';
import type { ActionContext } from '../src/domain';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';
import '../src/panels/list/maestro-task-tile.css';
/* THE `.tws-browser` SCOPE IS LOAD-BEARING, and the first run of this harness
   is what proved it: every `.lp-lead` rule lives in `browser.css` under
   `.cv2-root .tws-browser`, so a panel mounted outside that class renders the
   Workspace browser's leading icon with NO geometry — an unstyled 18px glyph
   and, on a row with children, a default-styled <button> sitting on top of its
   own title. That is a harness artifact and not a product defect, which is
   exactly the kind of thing a screenshot of the wrong composition would have
   been reported as a regression. The wrapper below puts the panel in the
   composition it actually ships in. */
import '../src/tab-workspace/view/browser.css';
/* `?shell=mobile` needs BOTH, and the first run proved why: every phone
   override is scoped to `[data-shell='mobile']` in `mobile-screens.css`, but
   the 44px floor those rules spend is `--mobile-touch-min`, declared on
   `.mobile-frame` in `mobile.css`. Without the frame the custom property is
   undefined, every `min-block-size: var(--mobile-touch-min)` is an invalid
   declaration the engine drops, and the harness reports a 22px target for a
   rule that is correct in the shipping shell. Measuring the harness instead of
   the product is the failure this file exists to avoid. Both are scoped, so a
   desktop panel here is byte-identical with them loaded. */
import '../src/mobile/mobile.css';
import '../src/mobile/mobile-screens.css';

/**
 * THE QUIET ROW AND THE ONE-ROW HEADER, PHOTOGRAPHED (task 01a1469f).
 *
 * Design doc 01a1465d §5–§6, approved change list message 01a14695-6b54.
 *
 * WHY THIS EXISTS, in one sentence: every claim the change makes is a
 * GEOMETRY claim, and the ~8,100 vitest assertions beside it run in jsdom,
 * which loads no stylesheets and implements no layout. None of them can see
 *
 *   1. that a row with no counts is ~29px and a row WITH them is ~43px, which
 *      is the whole §6 height budget;
 *   2. that the header is ONE 28px band where four used to stack (a bordered
 *      search row, a 28px lifecycle rail, a filter-chip row, a View picker) —
 *      ~120px of a 300px column before the first row of work;
 *   3. that `⋯` lands in the time's slot and the row does not change width
 *      between hovered and not;
 *   4. that the title still truncates FIRST and the signal and time never do,
 *      at the 240px floor as well as at 480.
 *
 * `?w=` sets the column widths (default `240,320,480`), so the same component
 * and the same fixtures are measured at both ends of the navigator's range
 * (240–480, `LAYOUT_BOUNDS` after design doc §4).
 *
 * Fixtures rather than the real seam, for the reason `list-header-chrome-harness`
 * next door states and for one more of my own: the real app at
 * `http://127.0.0.1:4612/` is behind `auth.login`, which a headless browser on
 * this box has no credential for, and what is under test here is pixels rather
 * than wiring. The live half — a count opening its group in the detail panel —
 * is a `Browser.tsx` → `SideLinks` seam and is covered by unit tests, not by
 * this file. Both facts are stated in the task's close-out rather than implied.
 *
 *   /e2e/quiet-tile-harness.html
 */
const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const TASK: EntitySummary = fixtureSummaries.find((s) => s.state.kind === 'task')!;
const DOC: EntitySummary = fixtureSummaries.find((s) => s.kind === 'doc')!;

/**
 * `?shell=mobile` paints the phone shell, which is a DIFFERENT set of rules and
 * not merely a narrower one: §7j′ (`mobile-screens.css`) rules that a CLOSED
 * row carries exactly one control — the opener — because the full control
 * strip it opens is a strictly larger set of verbs than any cluster. The quiet
 * row has to honour that under its own class names, and a stylesheet regex
 * cannot tell whether it does.
 */
const SHELL = new URLSearchParams(location.search).get('shell') === 'mobile' ? 'mobile' : undefined;

const WIDTHS: readonly number[] = (() => {
  const raw = new URLSearchParams(location.search).get('w');
  const parsed = (raw ?? '240,320,480')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n >= 200 && n <= 720);
  return parsed.length > 0 ? parsed : [240, 320, 480];
})();

const counters = (patch: Record<string, number>): EntityCounters =>
  ({ ...DOC.counters, ...patch }) as EntityCounters;

function row(
  template: EntitySummary,
  id: string,
  title: string,
  patch: Partial<EntitySummary> & { state?: unknown } = {},
): EntitySummary {
  return {
    ...template,
    id: id as EntitySummary['id'],
    title,
    parentId: null,
    deletedAt: null,
    ...patch,
  } as EntitySummary;
}

/**
 * THE POPULATION IS CHOSEN TO PUT EVERY §6 CASE ON SCREEN AT ONCE: a plain
 * one-line row, a row with a counts line, a row with children, an urgent row,
 * a row with every count the five groups allow (including the three the server
 * does not send yet, so the line is photographed at its real maximum width),
 * and a title long enough to truncate at 240.
 */
const ROWS: readonly EntitySummary[] = [
  row(TASK, 'q-1', 'Quieter list tiles', {
    category: 'in_progress' as StatusCategory,
    state: { ...TASK.state, status: 'working' },
  }),
  row(TASK, 'q-2', 'Merge the icon rail into the list panel and remove Home', {
    category: 'in_progress' as StatusCategory,
    state: { ...TASK.state, status: 'working' },
    counters: counters({ docs: 1, artifacts: 1 }),
  }),
  /* THE PARENT: `▸ 2` after the title, collapsed, which is the default. */
  row(TASK, 'q-3', 'Server: auto-link what a session produced', {
    category: 'to_do' as StatusCategory,
    state: { ...TASK.state, status: 'open' },
    counters: counters({ docs: 2, memories: 3 }),
  }),
  row(TASK, 'q-3-a', 'Backfill the old rows', { parentId: 'q-3' as EntitySummary['id'], category: 'to_do' as StatusCategory, state: { ...TASK.state, status: 'open' } }),
  row(TASK, 'q-3-b', 'Counters on session, task and chat', { parentId: 'q-3' as EntitySummary['id'], category: 'to_do' as StatusCategory, state: { ...TASK.state, status: 'open' } }),
  /* THE ONLY PRIORITY A ROW SHOWS. */
  row(TASK, 'q-4', 'Rail gaps: 12px → 4px', {
    category: 'to_do' as StatusCategory,
    state: { ...TASK.state, status: 'open', priority: 'urgent' },
  }),
  /* THE COUNTS LINE AT FULL WIDTH — all five groups, which is also the widest
     the second line can get. `prs` / `drawings` are not on `EntityCounters`
     yet and are read defensively, so this row proves the line fills in with no
     UI change the day 01a14655-e507 lands. */
  row(TASK, 'q-5', 'Craft phase 2: pages, chats and sessions', {
    category: 'to_do' as StatusCategory,
    state: { ...TASK.state, status: 'blocked' },
    counters: counters({ docs: 4, prs: 2, artifacts: 1, drawings: 3, memories: 12 } as Record<string, number>),
  }),
  row(TASK, 'q-6', 'Spike: CRDT for doc bodies', {
    category: 'done' as StatusCategory,
    state: { ...TASK.state, status: 'done' },
  }),
  /* A kind with NO signal and no counts: the quiet floor, and the row the
     height budget is measured against. */
  row(DOC, 'q-7', 'Design: one left navigator (icon rail + list panel merged)', {
    category: 'to_do' as StatusCategory,
  }),
  row(DOC, 'q-8', 'HOW-TO-TEST', { category: 'to_do' as StatusCategory, counters: counters({ docs: 1 }) }),
  /* The standard tile's own parent, urgent row and full counts line — the
     control card above has one of each and so must this one. */
  row(DOC, 'q-9', 'Design notes', {
    category: 'to_do' as StatusCategory,
    counters: counters({ docs: 2, prs: 1, artifacts: 3, drawings: 1, memories: 7 } as Record<string, number>),
  }),
  row(DOC, 'q-9-a', 'Widths and the collapsed state', { parentId: 'q-9' as EntitySummary['id'], category: 'to_do' as StatusCategory }),
  row(DOC, 'q-9-b', 'Keyboard and accessibility', { parentId: 'q-9' as EntitySummary['id'], category: 'to_do' as StatusCategory }),
  row(DOC, 'q-10', 'Rollout checklist', {
    category: 'to_do' as StatusCategory,
    state: { kind: 'task', status: 'working', priority: 'urgent' },
  }),
];

const TOTALS: Record<string, number> = { to_do: 18, in_progress: 6, done: 131, cancelled: 4, all: 159 };

/**
 * TWO PANELS, BECAUSE THERE ARE TWO ANATOMIES AND THE PANEL'S KIND PICKS ONE.
 *
 * `EntityListPanel` draws every row through the config of ITS OWN kind, so a
 * doc fixture inside a `kind="task"` panel renders as a control card — which
 * is what the first run of this harness did, and it meant the standard tile
 * (where most of the quiet-row code lives) was never photographed at all. The
 * Tasks panel below is the control card; the Docs panel is the standard tile.
 */
/**
 * THE THIRD ANATOMY. `work_session` is `session-tree`, the one tile the quiet
 * row changed least and the only one that keeps its lead icon as its
 * disclosure — a session's sub-session count rides the agent mark, which §6
 * keeps as "the session glyph tinted by its state". What it DID lose is the
 * model name, the lane line and the worktree door; what it keeps, by the
 * ruling of 2026-10-17, is the teammate face (that mark IS the kind glyph) and
 * the pending-forms chip (a request, not a facet).
 *
 * Four verdicts on screen at once, because the liveness mark is the signal and
 * one state proves nothing about the other three.
 */
const SESSIONS: readonly EntitySummary[] = [
  { ...sessionLive, id: 's-live' as EntitySummary['id'], parentId: null },
  {
    ...sessionStale,
    id: 's-stale' as EntitySummary['id'],
    parentId: null,
    counters: counters({ docs: 2, artifacts: 1, memories: 4 }),
  },
  { ...sessionExited, id: 's-exited' as EntitySummary['id'], parentId: null },
  { ...sessionFailed, id: 's-failed' as EntitySummary['id'], parentId: null },
];

/** The verdict the seam reports, by row — the signal's only honest source. */
const VERDICTS: Record<string, string> = {
  's-live': 'live',
  's-stale': 'stale',
  's-exited': 'not-running',
  's-failed': 'not-running',
};

function rowsOf(kind: string) {
  if (kind === 'work_session') return (): readonly EntitySummary[] => SESSIONS;
  return (filter: QueryFilter): readonly EntitySummary[] =>
    ROWS.filter(
      (r) => r.kind === kind && (!filter.category || filter.category.includes(r.category as StatusCategory)),
    );
}

function pageStateOf(filter?: unknown): { hasMore: boolean; loading: boolean; total: number } {
  const cat = ((filter ?? {}) as QueryFilter).category?.[0];
  return { hasMore: false, loading: false, total: cat ? (TOTALS[cat] ?? 0) : TOTALS.all };
}

const MEMBERS: readonly ActorSummary[] = fixtureActors;
const CAPS = { canEdit: true, canDelete: true, canReact: true, canComment: true } as never;

/** The counts line's door, logged rather than wired: a harness has no detail panel. */
const onOpenLinks = (entityId: string, groupKind: string): void => {
  // eslint-disable-next-line no-console
  console.log('openLinks', entityId, groupKind);
};

const ANATOMY: Record<string, string> = { task: 'control-card', doc: 'standard', work_session: 'session-tree' };

function Panel({ theme, width, kind }: { theme: 'light' | 'dark'; width: number; kind: 'task' | 'doc' | 'work_session' }) {
  return (
    <div className="harness-col">
      <div className="harness-cap">{`${theme} · ${width}px · ${ANATOMY[kind]}`}</div>
      <div
        className={SHELL ? 'cv2-root harness-panel mobile-frame' : 'cv2-root harness-panel'}
        data-theme={theme}
        data-shell={SHELL}
        style={{ width: `${width}px` }}
      >
       <section className="tws-browser" data-testid="tws-browser">
        <div className="tws-browser-list">
        <EntityListPanel
          kind={kind}
          rowsFor={rowsOf(kind)}
          pageStateOf={pageStateOf}
          members={MEMBERS}
          ctx={ctx}
          /* The Workspace browser's exact composition — `chrome="toolbar"` is
             what draws the one-row header, and `rowLead="icon"` its lead. */
          chrome="toolbar"
          rowLead="icon"
          selectorSlot="host"
          mode="list"
          compact
          onOpenLinks={onOpenLinks}
          /* Wired so the rows draw the LIVE state control rather than the
             refusal wrapper, which pads and dims the mark — see
             `list-header-chrome-harness` for the measurement this protects. */
          onSetState={() => {}}
          capabilitiesOf={() => CAPS}
          onSelect={() => {}}
          /* The signal on a session row is the NODE's verdict, never
             `state.status` (R-UI-5), so the harness has to supply one. */
          livenessOf={(id) => VERDICTS[id] as never}
        />
        </div>
       </section>
      </div>
    </div>
  );
}

function Harness() {
  return (
    <div className="harness-grid">
      {(['task', 'doc', 'work_session'] as const).flatMap((kind) =>
        (['light', 'dark'] as const).flatMap((theme) =>
          WIDTHS.map((w) => <Panel key={`${kind}-${theme}-${w}`} theme={theme} width={w} kind={kind} />),
        ),
      )}
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; background: #6b6b6b; font-family: system-ui, sans-serif; }
  .harness-grid { display: flex; flex-wrap: wrap; gap: 14px; padding: 14px; align-items: flex-start; }
  .harness-col { display: flex; flex-direction: column; gap: 6px; }
  .harness-cap { font: 700 11px/1.4 ui-monospace, monospace; color: #fff; letter-spacing: 0.03em; }
  .harness-panel { height: 420px; overflow: hidden; background: var(--pn-surface, #fff); border-radius: 8px; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<Harness />);
