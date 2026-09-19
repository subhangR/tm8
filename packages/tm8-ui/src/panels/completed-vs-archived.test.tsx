// @vitest-environment jsdom
/**
 * NOTHING IN A LIST IS STRUCK THROUGH, AND `done` IS WHY.
 *
 * Sub-doc 5's collisions C2 and C3 are pinned here, and so is the collision
 * that finally removed the completed treatment altogether.
 *
 * ## The collision: `done` is a RESOLUTION predicate, not a lifecycle position
 *
 * `db/migrations/152_universal_status.sql` seeds the FACT KINDS — commit,
 * message, file, memory, artifact — into `status_category = 'done'` ON PURPOSE,
 * so that a fact about the past cannot block a `depends_on` forever. Its header
 * says so, and `domain/registry.ts` already documents the same collision for
 * the category tab row (those kinds get `categories: null` rather than a
 * four-stage workflow they do not have).
 *
 * The LIST ROW was the last place still reading that resolution flag as "this
 * finished" and painting a completion mark with it: `completed` fed
 * `lp__title--completed` and `MaestroTaskTile`'s `completed` prop, and both
 * meant `text-decoration: line-through`. So EVERY artifact, EVERY memory, file,
 * message and commit rendered struck — twelve of twelve titles on the prod
 * Artifacts list.
 *
 * The fix is not a kind gate. Per Subhang's ruling the strikethrough leaves the
 * entity list for EVERY kind, completed tasks included: the status chip, the
 * status dot and the Done tab already say a task finished, and they say it
 * without claiming an artifact was completed. `pn-head__title--struck` (the
 * DETAIL header, driven by `deletedAt`) is a different fact and stays.
 *
 * ## What still must not collide
 *
 * C2 — ARCHIVED (`deletedAt`) and COMPLETED (`category === 'done'`) are two
 * orthogonal facts. `--archived` dims at 0.62 and is the ONE axis a list title
 * still paints; it must never be fed by a category. This is the collision that
 * ~3,900 tests could not see (see the negative control below), so the dimming
 * assertions stay exactly as strict as they were.
 *
 * C3 — `completed` has ONE definition for every kind, `category === 'done'`,
 * and it survives as a computed fact because the SESSION tile still consumes
 * it: for a `done` TEXT TAG, not a strikethrough, and no fact kind renders as a
 * session. A cancelled task is still not completed.
 *
 * === NEGATIVE CONTROL (measured on the pre-phase-9 tree, break applied, run,
 * reverted) ===
 * Instrument: `npx vitest run` from `packages/tm8-ui`.
 *
 *   BREAK — `const completed = archived || statusWord === 'done'`.
 *     Tests  3884 passed | 4 skipped (3888)   ← NOTHING RED.
 *
 *   THE ENTIRE SUITE PASSED WITH THE DEFECT IN PLACE. That is why this file
 *   exists, and why the strikethrough check below reads the CSS rather than
 *   asserting a class name is absent: after this change `lp__title--completed`
 *   is gone from BOTH the stylesheet and the component, so `expect(...class...)
 *   .toBe(false)` would be true forever and prove nothing. The check instead
 *   derives the struck-through SELECTORS from the list stylesheets and asserts
 *   no rendered row matches one.
 *
 * === NEGATIVE CONTROL FOR THIS FILE (measured on the fixed tree, each break
 * applied, run, reverted; `npx vitest run src/panels/completed-vs-archived`) ===
 *
 *   BREAK A — restore `.pn-tt--completed .pn-tt__title { line-through }` and
 *             re-emit the class from `MaestroTaskTile` (the control card, which
 *             is how a TASK renders).
 *     3 failed | 6 passed — the completed-task case, the archived+done case,
 *     and the stylesheet check. The archived-TO-DO and no-category cases stay
 *     GREEN, which is the point: they are not completed and must not red here.
 *
 *   BREAK B — restore `.lp__title--completed { line-through }` and re-emit the
 *             class from the generic row (which is how a FACT KIND renders).
 *     3 failed | 6 passed — the artifact case, the memory case, and the
 *     stylesheet check. This is the reported defect, and it reds.
 *
 *   Both anatomies are therefore covered, and an earlier draft of the scan was
 *   caught by break A: flattening selectors to class names made it red six of
 *   nine cases, because `.pn-tt__title` is on every task tile whether or not
 *   its ancestor carries the hook.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fireEvent, render } from '@testing-library/react';
import type { EntitySummary, QueryFilter, StatusCategory } from '@tm8/contract';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
import type { ActionContext } from '../domain';
import { EntityListPanel } from './index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const TASK: EntitySummary = fixtureSummaries.find((s) => s.state.kind === 'task')!;
const SESSION: EntitySummary = fixtureSummaries.find((s) => s.state.kind === 'work_session')!;
const ARTIFACT: EntitySummary = fixtureSummaries.find((s) => s.state.kind === 'artifact')!;
const MEMORY: EntitySummary = fixtureSummaries.find((s) => s.state.kind === 'memory')!;

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

function session(
  id: string,
  title: string,
  status: string,
  category: StatusCategory,
): EntitySummary {
  return {
    ...SESSION,
    id: id as EntitySummary['id'],
    title,
    parentId: null,
    deletedAt: null,
    category,
    state: { ...SESSION.state, status } as EntitySummary['state'],
  };
}

/** A fact-kind row as the server actually hands it over: `category: 'done'`,
    because `kind_seeds_done` says so and NOT because anything finished. */
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

/** Honours `category` and `deleted` the way the seam does. */
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

/**
 * EVERY SELECTOR THE LIST STYLESHEETS STRIKE THROUGH, read out of the CSS.
 *
 * Only the two files that dress an entity list row are read. Other surfaces
 * legitimately strike text through (a done checklist item in `subtree-body`, a
 * revoked invite, `md-root del`) and are not this contract.
 *
 * `.cv2-root` is stripped off the front so the selectors can be matched
 * against a tile rendered bare in jsdom, which mounts no app shell. The rest of
 * each selector is kept WHOLE and matched with `matches`/`querySelector` rather
 * than reduced to a bag of class names: `.pn-tt--completed .pn-tt__title` names
 * two classes and only one of them is the hook — flattening it would red every
 * task tile in the file, since they all carry `pn-tt__title`.
 *
 * `pn-head__title--struck` is picked up here, and that is correct: it lives in
 * `panels.css`, it is the DETAIL header's `deletedAt` mark, and a LIST never
 * mounts it — so it can only red a row if a list starts emitting it.
 */
function struckThroughSelectors(): readonly string[] {
  const files = ['panels.css', 'list/maestro-task-tile.css'].map((name) =>
    readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8'),
  );
  const selectors = new Set<string>();
  for (const css of files) {
    // Comments first: these files carry long prose that names the very
    // selectors this scan looks for, and a rule is only a rule outside one.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const [, selector, body] of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/text-decoration\s*:[^;]*\bline-through\b/.test(body)) continue;
      for (const one of selector.split(',')) {
        const trimmed = one.trim().replace(/^\.cv2-root\s+/, '');
        if (trimmed.startsWith('.') || trimmed.startsWith('[')) selectors.add(trimmed);
      }
    }
  }
  return [...selectors];
}

const STRUCK = struckThroughSelectors();

/** The tile element whose title is `title`, whatever anatomy drew it. */
function tileOf(container: HTMLElement, title: string): HTMLElement {
  const tile = [...container.querySelectorAll('[data-testid="list-tile"], .pn-st')].find((el) =>
    (el.textContent ?? '').includes(title),
  );
  if (!tile) throw new Error(`no tile rendered for ${title}\n${container.textContent}`);
  return tile as HTMLElement;
}

/** Struck through = this row wears a class the list stylesheets line-through,
    or says it inline. Either is the treatment this file forbids. */
function isStruck(tile: HTMLElement): boolean {
  if (STRUCK.some((selector) => tile.matches(selector) || tile.querySelector(selector) !== null)) {
    return true;
  }
  const elements = [tile, ...tile.querySelectorAll('*')] as HTMLElement[];
  return elements.some((el) => /line-through/.test(el.getAttribute('style') ?? ''));
}

function isDimmed(tile: HTMLElement): boolean {
  return (
    tile.classList.contains('pn-tt--archived') ||
    tile.classList.contains('pn-st--archived') ||
    tile.querySelector('.lp__title--archived') !== null
  );
}

/**
 * Completion is still LEGIBLE — the ruling drops the mark, not the fact. The
 * session tile keeps its `done` TAG; the other two anatomies say it in the
 * STATUS SLOT (`pn-tt__status-text` on the control card, `lp__word` on the
 * generic row), which is the same slot the dot colours and the Done tab reads.
 *
 * Read off those elements and not off `textContent`: a tile's flat text splices
 * every disabled-action tooltip in the row against the status word with no
 * separator, so a whole-tile regex answers a question about tooltips.
 */
function readsAsCompleted(tile: HTMLElement): boolean {
  if (tile.querySelector('.pn-st__tag--done') !== null) return true;
  const slots = tile.querySelectorAll('.pn-tt__status-text, .lp__word');
  return [...slots].some((el) => (el.textContent ?? '').trim().toLowerCase() === 'done');
}

/** Switch to a category tab by its visible word. */
function tab(view: { getByRole: (r: string, o: object) => HTMLElement }, label: string) {
  fireEvent.click(view.getByRole('tab', { name: new RegExp(`^${label}`) }));
}

/** Turn on the archive filter option by its visible label. */
function archiveFilter(view: {
  getByTestId: (id: string) => HTMLElement;
  getByRole: (r: string, o: object) => HTMLElement;
}, label: string) {
  fireEvent.click(view.getByTestId('filter-trigger'));
  fireEvent.click(view.getByRole('menuitemcheckbox', { name: label }));
}

describe('the entity list strikes nothing through — `done` is a resolution predicate', () => {
  it('an ARTIFACT row, category `done` by seed, renders with no strikethrough', () => {
    /**
     * THE REPORTED DEFECT, EXACTLY. Nothing about this row finished; migration
     * 152 files artifacts under `done` so a published bundle cannot hold a
     * `depends_on` open. The row used to be struck through for it — all twelve
     * visible titles on the prod Artifacts list were.
     */
    const rows = [fact(ARTIFACT, 'a-pulse', 'Pulse board'), fact(ARTIFACT, 'a-runbook', 'Runbook')];
    const view = render(<EntityListPanel kind="artifact" rowsFor={rowsForOf(rows)} ctx={ctx} />);

    for (const title of ['Pulse board', 'Runbook']) {
      const tile = tileOf(view.container, title);
      expect(isStruck(tile), `${title} is a fact, not finished work`).toBe(false);
      expect(isDimmed(tile), `${title} is not archived either`).toBe(false);
    }
  });

  it('a MEMORY row, category `done` by the same seed, renders with no strikethrough', () => {
    const rows = [fact(MEMORY, 'm-tokens', 'What the tokens cost')];
    const view = render(<EntityListPanel kind="memory" rowsFor={rowsForOf(rows)} ctx={ctx} />);

    expect(isStruck(tileOf(view.container, 'What the tokens cost'))).toBe(false);
  });

  it('a COMPLETED TASK is not struck through either, and is still legible as done', () => {
    // The ruling is list-wide: the mark goes, for every kind. A kind gate would
    // have left the same class one `row.kind` check away from painting a fact
    // again, and completion already has three other ways to show itself.
    const rows = [task('t-done', 'Shipped it', 'done', 'done')];
    const view = render(<EntityListPanel kind="task" rowsFor={rowsForOf(rows)} ctx={ctx} />);
    tab(view, 'Done');

    const tile = tileOf(view.container, 'Shipped it');
    expect(isStruck(tile), 'no line-through on a completed task').toBe(false);
    expect(readsAsCompleted(tile), 'completion is still said, in the status slot').toBe(true);
  });

  it('the list stylesheets declare no completion strikethrough at all', () => {
    // The class-absence assertions above go vacuously true if someone restores
    // the rule but not the emission. This is the other half: no `--completed`
    // hook may be struck through in either list stylesheet.
    expect(STRUCK.filter((selector) => selector.includes('--completed'))).toEqual([]);
    // And the scan itself is alive — it still finds the detail header's
    // `deletedAt` rule in `panels.css`, which is correct and is left alone.
    expect(STRUCK).toContain('.pn-head__title--struck');
  });
});

describe('C2 — an ARCHIVED row is dimmed, and dimming is the only mark left', () => {
  const ROWS = [
    task('t-arch-todo', 'Archived but never started', 'open', 'to_do', true),
    task('t-arch-done', 'Archived after finishing', 'done', 'done', true),
  ];

  it('an archived TO-DO task does NOT render as completed', () => {
    /**
     * THE ORIGINAL DEFECT. `const done = row.deletedAt != null` fed the tile's
     * `completed` prop, so archiving an untouched task drew a line through it
     * — the product telling a user work was finished when it was filed away.
     * The strikethrough is gone now, so this case can no longer fail that way;
     * what it still pins is the direction of the remaining axis — archived
     * dims, and dimming is never fed by a category.
     */
    const view = render(
      <EntityListPanel kind="task" rowsFor={rowsForOf(ROWS)} ctx={ctx} />,
    );
    archiveFilter(view, 'Archived only');
    tab(view, 'To Do');

    const tile = tileOf(view.container, 'Archived but never started');
    expect(isStruck(tile), 'archived is not completed').toBe(false);
    expect(isDimmed(tile), 'archived reads as archived').toBe(true);
  });

  it('a row that is BOTH archived and done is dimmed once, and struck never', () => {
    // The two are orthogonal axes, so they compose rather than override. The
    // completed half of that composition is now carried by the status slot
    // rather than by a second title treatment.
    const view = render(
      <EntityListPanel kind="task" rowsFor={rowsForOf(ROWS)} ctx={ctx} />,
    );
    archiveFilter(view, 'Archived only');
    tab(view, 'Done');

    const tile = tileOf(view.container, 'Archived after finishing');
    expect(isDimmed(tile), 'archived is still archived').toBe(true);
    expect(isStruck(tile), 'and nothing in a list is struck through').toBe(false);
  });
});

describe('C3 — ONE definition of completed, for every kind', () => {
  it('a DONE task reads as done and a CANCELLED one does not', () => {
    /**
     * The semantic change the fourth category exists to make (sub-doc 5's
     * "worth saying out loud"): a cancelled task STOPPED, it did not finish.
     * `cancelled` used to ride inside Done and inside the Completed band, so
     * abandoned work and shipped work wore the same mark. Neither wears a
     * strikethrough now, and they are still two different words.
     */
    const rows = [
      task('t-done', 'Shipped it', 'done', 'done'),
      task('t-cancelled', 'Abandoned it', 'cancelled', 'cancelled'),
    ];
    const view = render(<EntityListPanel kind="task" rowsFor={rowsForOf(rows)} ctx={ctx} />);

    tab(view, 'Done');
    expect(readsAsCompleted(tileOf(view.container, 'Shipped it'))).toBe(true);

    tab(view, 'Cancelled');
    const cancelled = tileOf(view.container, 'Abandoned it');
    expect(readsAsCompleted(cancelled), 'cancelled is not completed').toBe(false);
    expect(isStruck(cancelled)).toBe(false);
  });

  it('a FAILED session is completed — the session tile no longer excludes it', () => {
    /**
     * The other half of C3, and the reason `completed` is still computed at
     * all. The session tile read `completed={recordedStatus === 'exited'}`, so
     * a crashed run rendered as unfinished — while the Done tab 36 lines up the
     * file counted it as done. Under the model `failed` is a runtime FACT that
     * gets a badge, and the run's category is `done`: it ended. The tile says
     * so with a `done` TAG, which is a word and not a line through a title.
     */
    const rows = [
      session('ws-failed', 'The run that crashed', 'failed', 'done'),
      session('ws-running', 'The run still going', 'running', 'in_progress'),
    ];
    const view = render(
      <EntityListPanel kind="work_session" rowsFor={rowsForOf(rows)} ctx={ctx} />,
    );

    tab(view, 'Done');
    const failed = tileOf(view.container, 'The run that crashed');
    expect(failed.querySelector('.pn-st__tag--done'), 'a crashed run ended').not.toBeNull();
    expect(isStruck(failed)).toBe(false);

    tab(view, 'In Progress');
    const running = tileOf(view.container, 'The run still going');
    expect(running.querySelector('.pn-st__tag--done'), 'a live run has not ended').toBeNull();
  });

  it('a row with NO category is not completed — absence is not a verdict', () => {
    // `EntitySummary.category` is optional and its absence means "this entity
    // has no position in a workflow". Reading that as `done` would have struck
    // through every row a rolling node could not categorise; it would still
    // file one under the Done tab, which is why the case is kept.
    const uncategorised: EntitySummary = {
      ...task('t-none', 'No status at all', 'open', 'to_do'),
    };
    delete (uncategorised as { category?: StatusCategory }).category;

    const view = render(
      <EntityListPanel
        kind="task"
        rowsFor={() => [uncategorised]}
        ctx={ctx}
      />,
    );
    const tile = tileOf(view.container, 'No status at all');
    expect(isStruck(tile)).toBe(false);
    expect(readsAsCompleted(tile)).toBe(false);
  });
});
