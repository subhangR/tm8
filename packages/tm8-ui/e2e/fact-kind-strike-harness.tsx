/**
 * FACT KINDS ARE NOT COMPLETED WORK — the four lists, side by side, in a real
 * browser.
 *
 * `db/migrations/152_universal_status.sql` seeds commit, message, file, memory
 * and artifact into `status_category = 'done'` on purpose, so a fact about the
 * past cannot hold a `depends_on` open. The entity list read that resolution
 * flag as "this finished" and struck every one of those titles through.
 *
 * jsdom cannot see a strikethrough — it loads no stylesheets and computes no
 * style — so the defect was invisible to the ~3,900 unit tests in this package
 * for as long as it shipped. `getComputedStyle(...).textDecorationLine` in a
 * real engine is the only instrument that answers the actual question, and it
 * answers it for INHERITED decoration too: `text-decoration` propagates down
 * from an ancestor block, so a rule on a row wrapper would strike a title that
 * carries no class of its own.
 *
 * Usage (see `capture-fact-kind-strike.mjs` beside this):
 *   npx vite --port 4620          # in this package
 *   node e2e/capture-fact-kind-strike.mjs
 */
import { createRoot } from 'react-dom/client';
import '../src/styles/tokens.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';
/* The tiles pull their own sheets through their component imports, but the
   disabled-action tooltip does NOT: `honesty.css` is loaded by the
   `src/panels/index.ts` barrel, which this harness bypasses by importing
   `EntityListPanel` directly. Without it every `hon-tip` unhides and paints
   its cause text straight over the row title — which is a MISSING SHEET, not
   a product defect, and it is exactly the kind of thing jsdom cannot tell you
   and a screenshot can. */
import '../src/panels/honesty/honesty.css';
import type { EntitySummary, StatusCategory } from '@tm8/contract';
import { EntityListPanel } from '../src/panels/EntityListPanel';
import type { ActionContext, QueryFilter } from '../src/domain';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../src/fixtures';

if (new URLSearchParams(location.search).get('theme') === 'dark') {
  document.documentElement.setAttribute('data-theme', 'dark');
}

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const ARTIFACT = fixtureSummaries.find((s) => s.state.kind === 'artifact')!;
const MEMORY = fixtureSummaries.find((s) => s.state.kind === 'memory')!;
const TASK = fixtureSummaries.find((s) => s.state.kind === 'task')!;

/** A fact kind as the server hands it over: `done` by seed, not by finishing. */
function fact(base: EntitySummary, id: string, title: string): EntitySummary {
  return {
    ...base,
    id: id as EntitySummary['id'],
    title,
    parentId: null,
    deletedAt: null,
    category: 'done',
  };
}

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

const ARTIFACTS = ['Pulse board', 'Runbook', 'Latency report', 'Deploy log viewer'].map((title, i) =>
  fact(ARTIFACT, `a-${i}`, title),
);
const MEMORIES = ['What the tokens cost', 'Where prod restarts from', 'Why 4612 is not yours'].map(
  (title, i) => fact(MEMORY, `m-${i}`, title),
);
/* Every category, plus the archived row, so the C2 separation is visible in one
   frame: archived still dims, and nothing at all is struck. */
const TASKS = [
  task('t-open', 'Still open', 'open', 'to_do'),
  task('t-doing', 'In flight', 'in_progress', 'in_progress'),
  task('t-done', 'Shipped it', 'done', 'done'),
  task('t-cancelled', 'Abandoned it', 'cancelled', 'cancelled'),
  task('t-arch', 'Archived after finishing', 'done', 'done', true),
];

function rowsForOf(rows: readonly EntitySummary[]) {
  return (filter: QueryFilter): readonly EntitySummary[] =>
    rows.filter((row) => {
      const deleted = filter.deleted ?? 'exclude';
      if (deleted === 'exclude' && row.deletedAt !== null) return false;
      if (deleted === 'only' && row.deletedAt === null) return false;
      if (filter.category && !filter.category.includes(row.category as StatusCategory)) return false;
      return true;
    });
}

function Column(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="harness-col">
      <h3>{props.label}</h3>
      {props.children}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <div className="cv2-root harness-root">
    <style>{`
      .harness-root {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px;
        padding: 14px; background: var(--pn-bg); min-height: 100vh;
      }
      .harness-col h3 {
        font: 600 11px/1.6 var(--pn-sans, system-ui); letter-spacing: 0.06em;
        text-transform: uppercase; color: var(--pn-ink-3); margin: 0 0 6px;
      }
    `}</style>
    <Column label="Artifacts — category `done` by seed">
      <EntityListPanel kind="artifact" rowsFor={rowsForOf(ARTIFACTS)} ctx={ctx} />
    </Column>
    <Column label="Memories — category `done` by seed">
      <EntityListPanel kind="memory" rowsFor={rowsForOf(MEMORIES)} ctx={ctx} />
    </Column>
    {/* The task column IGNORES the filter on purpose. The panel opens on To Do
        and excludes archived rows, so an honouring seam shows exactly one of
        these five and the frame answers nothing about `done` or archived. This
        is a look-at-it harness, not a filtering one. */}
    <Column label="Tasks — every category, all tabs at once">
      <EntityListPanel kind="task" rowsFor={() => TASKS} ctx={ctx} />
    </Column>
  </div>,
);
