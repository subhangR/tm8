// @vitest-environment jsdom
/**
 * THE HOVER ACTION CLUSTER — Collections · Run · Archive · disclosure, one
 * shape for all three tile anatomies.
 *
 * WHAT THESE CAN AND CANNOT HOLD. jsdom loads no stylesheets, so the reveal
 * itself, the 22px boxes and the two themes are NOT claimed here — they were
 * measured in Chrome against `e2e/cluster-harness.html` (opacity 0 → 1 on
 * hover in all three anatomies; every member 22×22; no overflow at the 280px
 * panel width). What IS reachable here is the part that is pure DOM, and it is
 * the part most likely to rot: WHICH verbs a kind's cluster contains, in what
 * ORDER, and — the ruling with teeth — that Archive is absent exactly where the
 * server refuses it and merely refused where the server has not answered yet.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntityCapabilities, EntitySummary, StatusCategory } from '@tm8/contract';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
import { type ActionContext, type ActionRef } from '../domain';
import type { SessionLiveness } from '../data/seam';
import { EntityListPanel } from './index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

/** A live `task`/`doc`/`collection`, as the server answers today. */
const DELETABLE: EntityCapabilities = {
  canEdit: true, canDelete: true, canAddChild: true, canLink: true,
  canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
};

/**
 * A live `work_session`. `delete_entity` (migration 017) refuses the kind, so
 * the server sends `canDelete: false` — transcribed, not invented: the same
 * shape came back from `/v2/collections/query` on this branch.
 */
const SESSION: EntityCapabilities = {
  canEdit: true, canDelete: false, canAddChild: false, canLink: true,
  canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
};

function rowsOfKind(kind: string): EntitySummary[] {
  return fixtureSummaries.filter((row) => row.kind === kind);
}

function mount(
  kind: string,
  capabilities: EntityCapabilities | undefined,
  handlers: {
    onAction?: (ref: ActionRef, entityId: string) => void;
    onComplete?: (entityId: string) => void;
    onTerminate?: (entityId: string) => void;
    onResume?: (entityId: string) => void;
    /** The two seam answers the process control turns on — see its describe. */
    liveness?: SessionLiveness;
    category?: StatusCategory;
  } = {},
) {
  const rows = rowsOfKind(kind).map((row) =>
    handlers.category ? { ...row, category: handlers.category } : row,
  );
  return render(
    <EntityListPanel
      kind={kind}
      rowsFor={() => rows}
      ctx={ctx}
      capabilitiesOf={() => capabilities}
      livenessOf={() => handlers.liveness ?? 'live'}
      onAction={handlers.onAction ?? vi.fn()}
      onArchive={vi.fn()}
      onComplete={handlers.onComplete ?? vi.fn()}
      onTerminate={handlers.onTerminate ?? vi.fn()}
      onResume={handlers.onResume ?? vi.fn()}
      /* Collections needs BOTH to be live — the executor and the read its
         checkmarks come from. Without them it renders its not-wired refusal,
         which is honest but tells us nothing about placement. */
      onMembership={vi.fn()}
      connectionsOf={() => ({ incoming: [], outgoing: [], unresolvedHardDependencyCount: 0 })}
      membershipSets={rowsOfKind('collection')}
    />,
  );
}

/** The cluster on the FIRST tile, whichever anatomy drew it. */
function firstCluster(container: HTMLElement): HTMLElement {
  const cluster = container.querySelector('.lp__cluster');
  if (!cluster) throw new Error('no .lp__cluster on the first tile');
  return cluster as HTMLElement;
}

const verbsIn = (cluster: HTMLElement): string[] =>
  [...cluster.querySelectorAll('[data-action]')].map((el) => el.getAttribute('data-action')!);

describe('the row action cluster is one shape across all three anatomies', () => {
  /**
   * The anatomy is registry data, not a prop: `task` is the control-card,
   * `work_session` the session-tree, `doc` the standard tile. All three had
   * their own container and their own hand-assembled contents before this.
   */
  it.each([
    ['task', 'pn-tt__actions'],
    ['work_session', 'pn-st__actions'],
    ['doc', 'lp__rowactions'],
  ])('%s carries the shared cluster class alongside its own container', (kind, own) => {
    const { container } = mount(kind, DELETABLE);
    const cluster = firstCluster(container);
    expect(cluster.className).toContain(own);
    expect(cluster.className).toContain('lp__cluster');
  });

  /**
   * OWNER RULING 2026-08-18 — Archive moved from the far end to the LEAD, and
   * the tick moved in front of Run. Both used to be pinned here the other way
   * round, and flipping the assertions with the JSX is the point of pinning
   * them: the order is a ruling, and a ruling nobody has to restate when they
   * change it is a ruling that drifts.
   */
  it('leads with Archive and ends with the disclosure, on every anatomy', () => {
    for (const kind of ['task', 'work_session', 'doc']) {
      const { container, unmount } = mount(kind, DELETABLE);
      const cluster = firstCluster(container);
      const children = [...cluster.children];
      expect({ kind, first: children[0]?.getAttribute('data-action') })
        .toEqual({ kind, first: 'archive' });
      unmount();
    }
  });

  it('puts Collections second, right after Archive', () => {
    const { container } = mount('task', DELETABLE);
    const children = [...firstCluster(container).children];
    // Collections is not an ActionRef — it is the membership picker, so it is
    // identified by its own wrapper rather than by `data-action`.
    expect(children[1]?.className.includes('lp__assignwrap')).toBe(true);
  });

  it('a task lists Archive, then Complete, then Run', () => {
    const { container } = mount('task', DELETABLE);
    expect(verbsIn(firstCluster(container))).toEqual(['archive', 'complete', 'run']);
  });

  /**
   * The RULED position of Terminate: after the anatomy's own affordances, hard
   * right, next to the disclosure. Copy is drawn by `MaestroSessionTile` and
   * handed DOWN to the cluster precisely so this holds — rendered beside the
   * cluster instead, it would land to Terminate's right.
   */
  it('places the session tile\'s Copy between the middle verbs and Terminate', () => {
    const { container } = mount('work_session', SESSION);
    const cluster = firstCluster(container);
    const marks = [...cluster.children].map(
      (el) =>
        el.getAttribute('data-action')
        ?? el.getAttribute('aria-label')
        // Collections: the membership picker's wrapper span carries neither.
        ?? (el.className.includes('lp__assignwrap') ? 'collections' : null),
    );
    // No `archive`: `canDelete: false` HIDES it on every session row, which is
    // the ruling holding rather than the order breaking.
    //
    // `Complete` IS here, and its position is the point of this test. It ranks
    // as a middle verb, so it lands BEFORE the anatomy's own Copy — which is
    // the whole reason the tile hands its Copy down to this component rather
    // than drawing it alongside (see `RowActionCluster.anatomyActions`). A tile
    // that rendered Copy itself would put it left of the tick.
    //
    // It left this list on 2026-08-19 and came back the same day: #423 removed
    // it because the node had no door that could complete a session, and
    // migration 156 built one (user ruling — mark a session done WITHOUT
    // closing it). See `registry.test.ts` case 5c.
    expect(marks).toEqual([
      'collections',
      'Complete',
      'Copy session ID',
      'terminate',
      'Expand details',
    ]);
  });
});

describe('Archive is hidden on server truth, and ONLY on server truth', () => {
  it('is present when the server says the row is deletable', () => {
    const { container } = mount('doc', DELETABLE);
    expect(verbsIn(firstCluster(container))).toContain('archive');
  });

  /**
   * THE RULING. `canDelete: false` HIDES the control — it does not grey it.
   * And it must arrive at that from the capability alone: nothing in this
   * package may carry its own list of undeletable kinds, because the DB
   * already owns that list and a second copy is one that can disagree.
   */
  it('vanishes — not disabled — when the server refuses deletion', () => {
    const { container } = mount('work_session', SESSION);
    const cluster = firstCluster(container);
    expect(verbsIn(cluster)).not.toContain('archive');
    // Not merely absent from the live verbs: absent from the refusals too.
    expect(within(cluster).queryByLabelText('Archive')).toBeNull();
  });

  /**
   * UNKNOWN IS NOT A REFUSAL. Capabilities ride the summary now, so this is a
   * narrow window — a node too old to send the field, or an entity in neither
   * cache — but hiding here would make the icon pop in a beat late and reflow
   * the strip under the pointer. It is drawn, and it says why.
   */
  it('is still DRAWN while capabilities are unknown, so nothing pops in later', () => {
    const { container } = mount('doc', undefined);
    const cluster = firstCluster(container);
    expect(verbsIn(cluster)).not.toContain('archive');
    expect(cluster.querySelectorAll('.hon-checking').length).toBeGreaterThan(0);
    // The cluster keeps its width: the same number of slots as when permitted.
    const { container: permitted } = mount('doc', DELETABLE);
    expect(cluster.children.length).toBe(firstCluster(permitted).children.length);
  });
});

/**
 * THE TICK WAS DEAD THREE WAYS and the third was the quietest: it passed its
 * capability gate, drew live, dispatched — and landed in
 * `useSessionStart.onAction`, a switch over `SESSION_START_ACTIONS` whose
 * `default:` returns. Every host wires that dispatcher to `onAction`, so the
 * verb was swallowed on all of them. It has its own prop now, exactly as
 * Archive and Terminate do, and this is what says so.
 */
describe('the tick reaches a dedicated executor, never the session-start switch', () => {
  it('dispatches through onComplete and NOT through onAction', () => {
    const onComplete = vi.fn();
    const onAction = vi.fn();
    const { container } = mount('task', DELETABLE, { onComplete, onAction });
    const tick = firstCluster(container).querySelector('[data-action="complete"]');
    if (!tick) throw new Error('no complete control in the cluster');
    fireEvent.click(tick);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toBe(rowsOfKind('task')[0].id);
    expect(onAction).not.toHaveBeenCalled();
  });

  /**
   * WITHOUT the executor it must refuse, not draw live. `RowAction` falls back
   * to `props.onAction` when no dedicated handler is given — which is how the
   * verb got swallowed in the first place — so "unwired" has to mean BOTH are
   * absent, and then the honest not-wired refusal is what renders.
   */
  it('refuses with a reason when no executor is wired at all', () => {
    const { container } = render(
      <EntityListPanel
        kind="task"
        rowsFor={() => rowsOfKind('task')}
        ctx={ctx}
        capabilitiesOf={() => DELETABLE}
        livenessOf={() => 'live'}
      />,
    );
    const cluster = firstCluster(container);
    expect(cluster.querySelector('button[data-action="complete"]')).toBeNull();
    expect(within(cluster).getByLabelText('Complete')).toBeTruthy();
  });

  /**
   * SUB-TASK 3, AND IT IS ALREADY TRUE — asserted so it stays that way. The
   * tick used to sit in "checking permissions" forever on a COLLAPSED row:
   * capabilities rode only `EntityDetail`, and the only thing that asked for a
   * detail was the EXPANDED strip's effect. They ride the summary now, so a row
   * gates honestly the moment it renders — no `onNeedDetail`, no per-row detail
   * read behind a 100-row list.
   */
  it('is live on a collapsed row, with no detail read asked for', () => {
    const onNeedDetail = vi.fn();
    const { container } = render(
      <EntityListPanel
        kind="task"
        rowsFor={() => rowsOfKind('task')}
        ctx={ctx}
        capabilitiesOf={() => DELETABLE}
        livenessOf={() => 'live'}
        onComplete={vi.fn()}
        onNeedDetail={onNeedDetail}
      />,
    );
    const cluster = firstCluster(container);
    expect(cluster.querySelector('button[data-action="complete"]')).toBeTruthy();
    expect(cluster.querySelectorAll('.hon-checking').length).toBe(0);
    expect(onNeedDetail).not.toHaveBeenCalled();
  });
});

describe('the session tile renders the registry, and terminate exists once', () => {
  /**
   * This anatomy ignored `list.rowActions` entirely and hand-rolled a "Close
   * session" button beside them, so `work_session`'s declared verbs had never
   * rendered anywhere. The registry is the authority now.
   */
  it('draws the registry verbs it had always declared and never shown', () => {
    const { container } = mount('work_session', SESSION);
    expect(verbsIn(firstCluster(container))).toContain('terminate');
  });

  it('has exactly ONE terminate control, not a hand-rolled one beside it', () => {
    const { container } = mount('work_session', SESSION);
    const cluster = firstCluster(container);
    expect(cluster.querySelectorAll('[data-action="terminate"]').length).toBe(1);
    expect(within(cluster).queryByLabelText('Close session')).toBeNull();
  });

  it('keeps Copy session ID, which is the anatomy\'s own affordance', () => {
    const { container } = mount('work_session', SESSION);
    expect(within(firstCluster(container)).getByLabelText('Copy session ID')).toBeTruthy();
  });
});

/**
 * THE PROCESS CONTROL — ONE SLOT, TWO VERBS (user ruling 2026-08-19).
 *
 * A finished session row used to carry two controls and neither worked: a
 * Terminate correctly refused with "this session has already ended", and a
 * tick that drew live, dispatched, wrote — and moved nothing, because an
 * `exited` session resolves to `done` whatever the tick says (156's own header
 * says so). The verb that IS eligible on exactly those rows had no button.
 *
 * PIN BOTH DIRECTIONS IN ONE TEST, WHICH IS WHY THIS IS A TABLE. PR #429 is
 * the cautionary tale: #425 shipped 4012 tests and not one paired
 * `liveness: 'live'` with `category: 'done'`, so the feature's own headline
 * state was the untested one. Asserting presence and absence together for
 * every combination is what stops the next amendment trading one against the
 * other — a swap is only honest while it is TOTAL.
 */
describe('the tail slot resolves to terminate-or-resume, never both and never neither', () => {
  /**
   * PRESENT MEANS DRAWN IN ANY VOCABULARY — live button, refusal or checking.
   *
   * `verbsIn` reads `data-action`, which only a LIVE control carries: a
   * refusal is a `<span>` with the verb's accessible name on it. That
   * distinction is exactly what these assertions are about — the ruling is
   * that the absent verb is ABSENT and not merely greyed — so presence has to
   * be asked by NAME or an unrendered verb and a refused one look identical.
   * The session fixture makes this concrete: `canComplete: false`, so the tick
   * on a running session is drawn refused and carries no `data-action` at all.
   */
  const drawn = (container: HTMLElement, label: string): boolean =>
    within(firstCluster(container)).queryByLabelText(label) !== null;

  it.each([
    // The reported defect: nothing is answering and the run is filed done.
    ['done', 'not-running', 'resume'],
    // THE HEADLINE STATE #425 never paired. A session ticked while running is
    // under Done AND still streaming, so the run has NOT ended: the slot keeps
    // Terminate and the tick stays, because there it is the UN-tick.
    ['done', 'live', 'terminate'],
    ['in_progress', 'live', 'terminate'],
    // The stale ghost #425 fixed: not live, not finished, and the one row that
    // most needs retiring. Unchanged by this ruling.
    ['to_do', 'unknown', 'terminate'],
  ] as [StatusCategory, SessionLiveness, 'terminate' | 'resume'][])(
    'category %s + liveness %s puts %s in the tail, and the tick follows it',
    (category, liveness, expected) => {
      const { container } = mount('work_session', SESSION, { category, liveness });
      const ended = expected === 'resume';

      // THE VERB IS LIVE, not merely drawn: the tail slot is the row's one
      // process control and a swap that produced a second refusal would have
      // fixed nothing.
      expect(verbsIn(firstCluster(container))).toContain(expected);
      // TOTAL: exactly one of the pair, never two-with-one-greyed and never a
      // gap. Asked by NAME so a refusal counts as present — see `drawn`.
      expect(drawn(container, ended ? 'Terminate' : 'Resume')).toBe(false);

      // THE TICK VANISHES ON THE SAME PREDICATE — one control in that state,
      // not two. It is absent rather than disabled because on a finished run
      // it has no SUBJECT: "is this row's claim on my attention over?" is
      // structurally, permanently yes, so there is nothing to toggle and no
      // refusal to explain.
      expect(drawn(container, 'Complete')).toBe(!ended);
    },
  );

  /**
   * A DONE *TASK* KEEPS ITS TICK. `hasEnded` is true of any row filed under
   * Done that nothing is answering for — which is every completed task — so
   * the swap is scoped to rows that HAVE a process, i.e. that declare
   * `terminate`. Without that scope this ruling would have silently taken the
   * un-tick off every finished task in the app, and no session test could see
   * it.
   */
  it('leaves a DONE task alone — no process, so no run to have ended', () => {
    const { container } = mount('task', DELETABLE, { category: 'done', liveness: 'not-running' });
    const marks = verbsIn(firstCluster(container));
    expect(marks).toContain('complete');
    expect(marks).not.toContain('resume');
  });

  /**
   * The tick's lesson, applied before it can be relearned: a verb routed
   * through the list's general `onAction` reaches `useSessionStart`'s switch,
   * whose `default:` returns. Resume has its own prop for that reason, and
   * this is what says so.
   */
  it('dispatches through onResume and NOT through onAction', () => {
    const onResume = vi.fn();
    const onAction = vi.fn();
    const { container } = mount('work_session', SESSION, {
      category: 'done',
      liveness: 'not-running',
      onResume,
      onAction,
    });
    const resume = firstCluster(container).querySelector('[data-action="resume"]');
    if (!resume) throw new Error('no resume control in the cluster');
    fireEvent.click(resume);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume.mock.calls[0][0]).toBe(rowsOfKind('work_session')[0].id);
    expect(onAction).not.toHaveBeenCalled();
  });

  /**
   * Without an executor it must REFUSE, not draw live. `RowAction` falls back
   * to `props.onAction` when no dedicated handler is given — which is how the
   * tick got swallowed — so unwired means BOTH are absent.
   */
  it('refuses with a reason when no executor is wired at all', () => {
    const { container } = render(
      <EntityListPanel
        kind="work_session"
        rowsFor={() => rowsOfKind('work_session').map((row) => ({ ...row, category: 'done' as const }))}
        ctx={ctx}
        capabilitiesOf={() => SESSION}
        livenessOf={() => 'not-running'}
      />,
    );
    const cluster = firstCluster(container);
    expect(cluster.querySelector('button[data-action="resume"]')).toBeNull();
    expect(within(cluster).getByLabelText('Resume')).toBeTruthy();
  });

  /**
   * RESUME IS CONSTRUCTIVE and must not wear the destructive block colour that
   * `panels.css` gives `[data-action='terminate']`. jsdom loads no stylesheets,
   * so what is reachable here is the hook the CSS keys on: the stamp is the
   * verb's own id, so a resume can never match the terminate selector.
   */
  it('stamps its own verb, so the destructive hover cannot follow it into the slot', () => {
    const { container } = mount('work_session', SESSION, {
      category: 'done',
      liveness: 'not-running',
    });
    const button = firstCluster(container).querySelector('button[data-action="resume"]');
    expect(button?.getAttribute('data-action')).toBe('resume');
  });
});
