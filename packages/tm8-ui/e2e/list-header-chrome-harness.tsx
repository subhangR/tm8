import { createRoot } from 'react-dom/client';
import type { ActorSummary, EntitySummary, QueryFilter, StatusCategory } from '@tm8/contract';
import { EntityListPanel } from '../src/panels';
import { FIXTURE_SPACE_ID, fixtureActors, fixtureSummaries } from '../src/fixtures';
import type { ActionContext } from '../src/domain';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';
import '../src/panels/list/maestro-task-tile.css';

/**
 * THE HOME TASK-LIST CHROME, AT BOTH ENDS OF ITS DRAG RANGE.
 *
 * Home's column A is draggable between `HOME_LIST_MIN` (240) and
 * `HOME_LIST_MAX` (560) — `views/HomeView.tsx`. Every complaint this harness
 * exists to photograph is a GEOMETRY or a CONTRAST fact, and the ~3,900 vitest
 * assertions beside it run in jsdom, which loads no stylesheets and has no
 * layout engine. None of them can see:
 *
 *   1. that the chrome is IDENTICAL at 240 and 560. Home passed `compact` as a
 *      hardcoded literal, so dragging the panel changed the list and nothing
 *      above it, and the row designed for the 240 floor was what a 560 column
 *      also got — 274px of empty row between the last chip and the sort
 *      control.
 *   2. that five stacked rows sat on FOUR different left edges (8 / 0 / 10 / 8
 *      / 10), which is the single biggest reason the stack reads as unaligned.
 *   3. that the sort control was a CIRCLE. Nothing declares a circle: it is
 *      `.lp__chip` — the same rule as Filter/People/Collections — carrying one
 *      character inside a 999px radius, so the pill closes into a disc on its
 *      own.
 *   4. the four WCAG contrast failures in the tab row, which need composited
 *      pixels rather than token names to state.
 *
 * `?compact=literal` reproduces what Home SHIPPED (the hardcoded prop);
 * `?compact=derived` measures it the way `WorkspaceView` already does. Both
 * live in one file so the before and after are the same component, the same
 * fixtures and the same engine — only the one prop moves.
 *
 * Fixtures rather than the real seam, for the same reason
 * `category-tabs-harness` uses them: what is under test is geometry across
 * widths, and fixtures put both ends on screen at once, deterministically,
 * with no server and no sign-in. The tab counts are the OWNER'S REAL NUMBERS
 * from the reported screenshot (225 / 175 / 131 / 28) because the row's width
 * budget depends on how many digits each count carries.
 *
 *   /e2e/list-header-chrome-harness.html
 */
const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const TASK: EntitySummary = fixtureSummaries.find((s) => s.state.kind === 'task')!;

function task(id: string, title: string, status: string, category: StatusCategory): EntitySummary {
  return {
    ...TASK,
    id: id as EntitySummary['id'],
    title,
    parentId: null,
    deletedAt: null,
    category,
    state: { ...TASK.state, status } as EntitySummary['state'],
  };
}

/* Titles long enough to exercise the row at 240 AND to leave the 560 column
   something to actually show — a fixture that fits both widths comfortably
   would hide the defect this harness is pointed at. */
const ROWS: readonly EntitySummary[] = [
  task('t-1', 'Read the Artifact created and Build the UI', 'open', 'to_do'),
  task('t-2', 'Remove stale root Claude Code install (operator commands)', 'open', 'to_do'),
  task('t-3', 'MCP 10/10 — The picker: attach servers when raising a chat', 'open', 'to_do'),
  task('t-4', 'MCP 9/10 — Seed the reference catalog as real entities', 'open', 'to_do'),
  task('t-5', 'MCP 5/10 — Graph-driven chat: swap the static source', 'open', 'to_do'),
  task('t-6', 'MCP 3/10 — Extend the equips edge registry', 'open', 'to_do'),
  task('t-7', 'Task List — Organize look and feel of it', 'working', 'in_progress'),
  task('t-8', 'Rebuild the task list chrome and the detail panel', 'done', 'done'),
  task('t-9', 'Spike: CRDT for doc bodies', 'cancelled', 'cancelled'),
];

/** The owner's real totals, so each tab carries its true digit count. */
const TOTALS: Record<StatusCategory | 'all', number> = {
  to_do: 225,
  in_progress: 175,
  done: 131,
  cancelled: 28,
  all: 559,
} as Record<StatusCategory | 'all', number>;

function rowsFor(filter: QueryFilter): readonly EntitySummary[] {
  return ROWS.filter((row) => {
    if (filter.category && !filter.category.includes(row.category as StatusCategory)) return false;
    return true;
  });
}

function pageStateOf(filter?: unknown): { hasMore: boolean; loading: boolean; total: number } {
  const f = (filter ?? {}) as QueryFilter;
  const cat = f.category?.[0] as StatusCategory | undefined;
  return { hasMore: false, loading: false, total: cat ? (TOTALS[cat] ?? 0) : TOTALS.all };
}

/* The People chip needs 2+; the Collections chip needs a sets array that is
   present (even empty means "this host wired it"). Both are chips whose SHAPE
   is under test, so both must actually render. */
const MEMBERS: readonly ActorSummary[] = fixtureActors;
const SETS: readonly EntitySummary[] = [
  { ...TASK, id: 'set-1' as EntitySummary['id'], kind: 'container', title: 'Launch' },
  { ...TASK, id: 'set-2' as EntitySummary['id'], kind: 'container', title: 'UI 2.0' },
] as unknown as readonly EntitySummary[];

/** Home's floor and ceiling — `HOME_LIST_MIN` / `HOME_LIST_MAX`. */
const WIDTHS = [240, 560] as const;

/**
 * The one prop under test. `literal` is what Home shipped at 2c0c292d; the
 * derived arm mirrors `WorkspaceView`'s `layout.left <= 220` rule, retuned for
 * a column whose floor is 240 rather than 200.
 */
const MODE = new URLSearchParams(location.search).get('compact') ?? 'literal';
const HOME_LIST_COMPACT_MAX = Number(
  new URLSearchParams(location.search).get('threshold') ?? '420',
);
const compactAt = (width: number): boolean =>
  MODE === 'literal' ? true : width <= HOME_LIST_COMPACT_MAX;

function Panel({ theme, width }: { theme: 'light' | 'dark'; width: number }) {
  return (
    <div className="cv2-root" data-theme={theme === 'dark' ? 'dark' : undefined}>
      <div className="harness-col">
        <div className="harness-cap">{`${width}px · ${theme} · compact=${String(compactAt(width))}`}</div>
        <div
          className="harness-panel"
          data-harness-theme={theme}
          data-harness-width={width}
          style={{ width: `${width}px` }}
        >
          <EntityListPanel
            kind="task"
            rowsFor={rowsFor}
            pageStateOf={pageStateOf}
            members={MEMBERS}
            membershipSets={SETS}
            ctx={ctx}
            compact={compactAt(width)}
          />
        </div>
      </div>
    </div>
  );
}

function Harness() {
  return (
    <div className="harness-grid">
      {WIDTHS.map((w) => (
        <Panel key={`l-${w}`} theme="light" width={w} />
      ))}
      {WIDTHS.map((w) => (
        <Panel key={`d-${w}`} theme="dark" width={w} />
      ))}
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; background: #6b6b6b; font-family: system-ui, sans-serif; }
  .harness-grid { display: flex; flex-wrap: wrap; gap: 14px; padding: 14px; align-items: flex-start; }
  .harness-col { display: flex; flex-direction: column; gap: 6px; }
  .harness-cap { font: 700 11px/1.4 ui-monospace, monospace; color: #fff; letter-spacing: 0.03em; }
  .harness-panel { height: 560px; overflow: hidden; background: var(--pn-card, #fff); border-radius: 8px; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<Harness />);
