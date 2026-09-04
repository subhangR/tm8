import { createRoot } from 'react-dom/client';
import type { EntitySummary, QueryFilter, StatusCategory } from '@tm8/contract';
import { EntityListPanel } from '../src/panels';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../src/fixtures';
import type { ActionContext } from '../src/domain';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';
import '../src/panels/list/maestro-task-tile.css';

/**
 * PHASE 7 / PHASE 9 — a PIXEL harness for the four category tabs, the archive
 * filter, and the completed-vs-archived treatments.
 *
 * WHY A HARNESS RATHER THAN THE APP. The vitest assertions beside this run in
 * jsdom, which LOADS NO STYLESHEETS AND HAS NO LAYOUT ENGINE. They can prove
 * there are four tabs, that each carries `{category:[id]}`, and that an
 * archived row gets `--archived` rather than `--completed`. They cannot prove:
 *
 *   · that FOUR tabs with counts still fit the 280px side panel. There were
 *     three before ("Open · Done · Archived") and the two longest words in the
 *     new set ("In Progress", "Cancelled") are both longer than any of them.
 *     A tab row that wraps or clips is a defect no assertion in this repo can
 *     see.
 *   · that COMPLETED and ARCHIVED are visually DISTINGUISHABLE. That is the
 *     whole of collision C2: the two facts shared one class and one
 *     strikethrough. The test asserts two different class names; only a
 *     screenshot asserts they look different.
 *   · that the archive chip reads as a filter rather than as a fourth tab that
 *     wandered down a row.
 *
 * FIXTURES, NOT THE REAL SEAM, ON PURPOSE — same reason as
 * `row-state-harness`: what is under test is GEOMETRY across states, and
 * fixtures put every state on screen at once, deterministically, with no
 * server and no sign-in.
 *
 * BOTH THEMES, because a token that only resolves in light is a defect this
 * package has shipped before.
 *
 *   /e2e/category-tabs-harness.html
 */
const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const TASK: EntitySummary = fixtureSummaries.find((s) => s.state.kind === 'task')!;

function task(
  id: string,
  title: string,
  status: string,
  category: StatusCategory,
  archived = false,
): EntitySummary {
  return {
    ...TASK,
    id: id as EntitySummary['id'],
    title,
    parentId: null,
    deletedAt: archived ? '2026-08-18T00:00:00.000Z' : null,
    category,
    state: { ...TASK.state, status } as EntitySummary['state'],
  };
}

/**
 * ONE ROW PER STATE, plus the two archived ones the C2 fix is about.
 * Deliberately includes a row that is BOTH archived and done — the case the
 * single `--done` class could not express at all.
 */
const ROWS: readonly EntitySummary[] = [
  task('t-1', 'Name the empty states', 'open', 'to_do'),
  task('t-2', 'Draft the migration note', 'pulled', 'to_do'),
  task('t-3', 'Session tree guide lines', 'working', 'in_progress'),
  task('t-4', 'Wire palette to registry', 'blocked', 'in_progress'),
  task('t-5', 'Ship the four tabs', 'done', 'done'),
  task('t-6', 'Spike: CRDT for doc bodies', 'cancelled', 'cancelled'),
  task('t-7', 'Archived, never started', 'open', 'to_do', true),
  task('t-8', 'Archived after finishing', 'done', 'done', true),
];

/** Honours the clauses the seam honours, so the tabs are really filtering. */
function rowsFor(filter: QueryFilter): readonly EntitySummary[] {
  return ROWS.filter((row) => {
    const deleted = filter.deleted ?? 'exclude';
    if (deleted === 'exclude' && row.deletedAt !== null) return false;
    if (deleted === 'only' && row.deletedAt === null) return false;
    if (filter.category && !filter.category.includes(row.category as StatusCategory)) return false;
    return true;
  });
}

/**
 * The server's own count, so the tab labels are EXACT numbers rather than the
 * `N+` hedge. This is what `Page.total` now supplies for real.
 */
function pageStateOf(filter?: unknown) {
  return { hasMore: false, loading: false, total: rowsFor((filter ?? {}) as QueryFilter).length };
}

function Panel({ theme, label }: { theme: 'light' | 'dark'; label: string }) {
  return (
    <div className="cv2-root" data-theme={theme === 'dark' ? 'dark' : undefined}>
      <div className="harness-col">
        <div className="harness-cap">{label}</div>
        {/* 280px — the real side-panel width. Four tabs that only fit at desk
            width have not been verified for where they actually ship. */}
        <div className="harness-panel" data-harness-theme={theme}>
          <EntityListPanel kind="task" rowsFor={rowsFor} pageStateOf={pageStateOf} ctx={ctx} />
        </div>
      </div>
    </div>
  );
}

function Harness() {
  return (
    <div className="harness-grid">
      <Panel theme="light" label="four tabs · light · 280px" />
      <Panel theme="dark" label="four tabs · dark · 280px" />
      <Panel theme="light" label="light · drive me (archive filter)" />
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; background: #6b6b6b; font-family: system-ui, sans-serif; }
  .harness-grid { display: flex; flex-wrap: wrap; gap: 14px; padding: 14px; align-items: flex-start; }
  .harness-col { display: flex; flex-direction: column; gap: 6px; }
  .harness-cap { font: 700 11px/1.4 ui-monospace, monospace; color: #fff; letter-spacing: 0.03em; }
  .harness-panel { width: 280px; height: 560px; overflow: auto; background: var(--pn-card, #fff); border-radius: 8px; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(<Harness />);
