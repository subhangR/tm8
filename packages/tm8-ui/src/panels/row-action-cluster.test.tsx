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
import type { EntityCapabilities, EntitySummary } from '@tm8/contract';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
import { type ActionContext, type ActionRef } from '../domain';
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
  } = {},
) {
  return render(
    <EntityListPanel
      kind={kind}
      rowsFor={() => rowsOfKind(kind)}
      ctx={ctx}
      capabilitiesOf={() => capabilities}
      livenessOf={() => 'live'}
      onAction={handlers.onAction ?? vi.fn()}
      onArchive={vi.fn()}
      onComplete={handlers.onComplete ?? vi.fn()}
      onTerminate={handlers.onTerminate ?? vi.fn()}
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
