import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
import './panels/honesty/honesty.css';
import './mobile/mobile.css';
import './mobile/mobile-screens.css';
import type { EntitySummary } from '@tm8/contract';
import { EntityListPanel } from './panels/EntityListPanel';
import type { ActionContext, QueryFilter } from './domain';
import { FIXTURE_SPACE_ID, fixtureSummaries } from './fixtures';

/**
 * THE TREE SCRATCH HARNESS — one list kind, a real parent/child shape, in a
 * real browser.
 *
 * jsdom loads no stylesheets, so it can say a count badge EXISTS and can say
 * nothing about whether it sits on the leading icon's corner or whether the
 * chevron still covers the status dot — the defect this harness was written
 * to see. The shape mirrors a live space's stories: three roots, one with
 * seven children, one with five, one with four, and a grandchild so the
 * second level is on screen too.
 *
 * Usage: /tree-dev.html
 *   ?kind=task     any kind with a fixture row; task, story, doc, container …
 *   ?open=1        expand every parent once mounted (default: collapsed)
 *   ?theme=dark    the dark ground
 *   ?width=420     the panel width, to exercise the narrow container queries
 *   ?shell=mobile  the phone shell's row geometry (`mobile-screens.css`)
 */
const params = new URLSearchParams(location.search);
if (params.get('theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');

const kind = params.get('kind') ?? 'task';
const template = fixtureSummaries.find((row) => row.kind === kind);
if (template === undefined) throw new Error(`tree-dev: no ${kind} fixture to clone`);

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

/** [title, parent index | null, status] — the parent always precedes its children. */
const SHAPE: readonly (readonly [string, number | null, string])[] = [
  ['TM8 UI Theme → customizable UI styles', null, 'working'],
  ['1 · The question: how the TM8 UI looks', 0, 'done'],
  ['2 · Pivot: styles become tm8 entities', 0, 'done'],
  ['3 · Phase 1 foundations — PR #998 merged', 0, 'done'],
  ['4 · Redesign with a Fable advisor', 0, 'review'],
  ['5 · Parallel build under a new lead', 0, 'blocked'],
  ['6 · Recovery: status read and this story', 0, 'working'],
  ['7 · Finish: Phase 3 editor + rate limits', 0, 'todo'],
  ['Story kind improvements', null, 'working'],
  ['1 · Story page UI', 8, 'working'],
  ['2 · Status & progress correctness', 8, 'todo'],
  ['3 · Reading stories & context', 8, 'todo'],
  ['4 · Spawning & coordination on stories', 8, 'todo'],
  ['5 · CLI ergonomics & docs', 8, 'todo'],
  ['Cross-space coordination, space auth & credentials', null, 'working'],
  ['Space credentials', 14, 'working'],
  ['Space boundary, space logins & authentication', 14, 'review'],
  ['Handoff coordinator — cross-space handoff', 14, 'done'],
  ['L3 · handoff receipts', 17, 'todo'],
  ['A leaf with no children', null, 'todo'],
];

const idOf = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` as EntitySummary['id'];

const rows: readonly EntitySummary[] = SHAPE.map(([title, parent, status], index) => ({
  ...template,
  id: idOf(index),
  title,
  parentId: parent === null ? null : idOf(parent),
  /* Only a task carries a workflow word; every other kind keeps its own state. */
  state: template.kind === 'task'
    ? ({ ...template.state, status } as EntitySummary['state'])
    : template.state.kind === 'story'
      ? { ...template.state, taskProgress: storyTally(index) }
      : template.state,
}));

/** A different task tally per story row, so the list's progress bars vary. */
function storyTally(index: number) {
  const work = index === SHAPE.length - 1 ? 0 : 3 + ((index * 5) % 9);
  const done = index % 4 === 1 ? work : Math.floor((work * (index % 5)) / 5);
  const inProgress = Math.min(work - done, index % 3);
  const blocked = Math.min(work - done - inProgress, index % 7 === 5 ? 1 : 0);
  return { work, done, inProgress, blocked, toDo: work - done - inProgress - blocked, cancelled: 0 };
}

const rowsFor = (_filter: QueryFilter): readonly EntitySummary[] => rows;

function useOpenTree() {
  useEffect(() => {
    if (params.get('open') !== '1') return;
    let cancelled = false;
    let remaining = SHAPE.length;
    const open = () => {
      if (cancelled) return;
      const shut = document.querySelectorAll<HTMLButtonElement>(
        'button[aria-expanded="false"]:is(.pn-tt__arrow, .pn-st__arrow, .lp__disclosure)',
      );
      shut.forEach((button) => button.click());
      remaining -= 1;
      if (shut.length > 0 && remaining > 0) window.setTimeout(open, 60);
    };
    const timer = window.setTimeout(open, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);
}

function TreeDev() {
  useOpenTree();
  const width = Number(params.get('width') ?? '') || 560;
  const shell = params.get('shell');
  return (
    <div
      /* `.mobile-frame` is where `--mobile-touch-min` is declared; without it
         every phone size rule resolves to nothing and the harness shows the
         desktop geometry under a phone attribute. */
      className={shell === 'mobile' ? 'cv2-root mobile-frame' : 'cv2-root'}
      data-shell={shell ?? undefined}
      style={{ padding: 20, width, boxSizing: 'border-box' }}
    >
      <EntityListPanel kind={kind} rowsFor={rowsFor} ctx={ctx} />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<TreeDev />);
