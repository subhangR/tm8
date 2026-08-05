// @vitest-environment jsdom
/**
 * THE TASK FLOW JOURNEY, THROUGH THE PANEL — assign, prioritise, and come back.
 *
 * THE REPORTED DEFECT, verbatim: "While Creating Task im not able to assign,
 * edit priority … also after task is archived or done im not ableot move it to
 * again to open as well the complete Task flow jourey to be fixed."
 *
 * Both halves were real, and neither was a server limitation:
 *
 *  1. CREATE-TIME ASSIGN / PRIORITY. The generic-create pattern (T5-6) commits
 *     the entity the instant "+ New task" is pressed and opens its PANEL with
 *     the title in edit focus — so the panel IS the create form, and it drew
 *     `workStatus` as a read-only header pill and `priority` / `assignees` as
 *     `<span>`s in the meta grid. There was no control on the one surface a
 *     new task is born on. `authoring/StatusSelect` had existed, fully built
 *     and exported, mounted by nothing but its own test.
 *
 *  2. THE WAY BACK. Two different doors, both shut:
 *     · DONE — `update_task_content` (038:378) and `set_work_state` (060:34)
 *       refuse only the value `done` ("completion goes through complete_task").
 *       Writing `open` FROM done is accepted from any state; nothing in the DB
 *       reads the current status. So reopening was never blocked — the panel
 *       simply had no state control to offer it.
 *     · ARCHIVED — archive is the shared TOMBSTONE (`deletedAt`), not a work
 *       status. `TombstoneBody` has always drawn a `Restore ▸` button, and no
 *       host has ever passed `onRestore`: it was enabled and inert since the
 *       day it was written. An archived task had a button that did nothing.
 *
 * These tests hold the WIRING, which is where all of it went wrong — every
 * individual piece was already green in its own suite.
 *
 * === RED-FIRST RECORD (measured; each break applied to the fixed tree, run,
 * captured, reverted) ===
 * Instrument: `npx vitest run src/panels/detail/panel-controls.test.tsx`
 * from `packages/tm8-ui` (banner `RUN v4.1.10 …/packages/tm8-ui`).
 *
 *   BREAK 1 — 2026-08-04T19:21Z. Gate off the `<EntityControlStrip>` mount in
 *             `EntityDetailPanel` (`{false && controlsFor(config) && …}`),
 *             which is HEAD's state as far as anything here can observe: a
 *             read-only header pill and `<span>`s in the meta grid.
 *     FAIL the panel mounts a REAL priority control, and it writes priority
 *       TestingLibraryElementError: Unable to find an element by:
 *       [data-testid="row-value-select"]
 *     FAIL the panel mounts a REAL assignee control, and it writes an EDGE
 *       …by: [data-testid="row-assign-trigger"]
 *     FAIL an unwired host refuses VISIBLY rather than hiding the control
 *       AssertionError: expected null not to be null
 *     FAIL a DONE task can be sent back to open, through the work verb
 *     FAIL reopening does NOT route through the completion verb
 *     FAIL completing still routes through the gated completion verb
 *       all three: …by: [data-testid="row-state-select"]
 *     FAIL is mounted for a live task
 *       AssertionError: expected null not to be null
 *     Tests  7 failed | 4 passed (11)
 *
 *   BREAK 2 — 2026-08-04T19:22Z. Strip restored; `TombstoneBody` reverted to
 *             the shape it shipped with — one `<button>` under `canRestore`
 *             alone, `onClick={onRestore}` whether or not a handler exists.
 *             This is the enabled-and-inert regression itself.
 *     FAIL an unwired Restore is disabled-with-reason, never enabled-and-inert
 *       AssertionError: expected 'BUTTON' not to be 'BUTTON' // Object.is equality
 *     Tests  1 failed | 10 passed (11)
 *
 *   Restored: Tests  11 passed (11).
 *
 * NOTE on what BREAK 2 does NOT cover: the missing `onRestore` at the HOST
 * (`EntityView` / `WorkspaceView`) is the defect users actually met, and this
 * file cannot catch it — it passes `onRestore` itself, as any caller would.
 * The host wiring is held by `views/`, not here.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { ActorSummary, EntityDetail, EntityId } from '@tm8/contract';
import { REASONS as DOMAIN_REASONS, getKind, type ActionContext } from '../../domain';
import {
  FIXTURE_SPACE_ID,
  fixtureDetails,
  presenceHollowReason,
  taskUuidTitle,
} from '../../fixtures';
import { EntityDetailPanel, type ControlHost, type DetailReasons } from '../index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'not in the stamped seam',
  withdrawUnavailable: 'not in the stamped seam',
};

/** The app's own task fixture, so capabilities, version and state shape are
    the ones the panel actually renders rather than a hand-built optimist. */
const TASK: EntityDetail = fixtureDetails[taskUuidTitle.id]!;

const ADA: ActorSummary = {
  id: 'member-ada' as EntityId,
  kind: 'member',
  displayName: 'Ada',
  avatar: null,
  isAgent: false,
};

/**
 * A fully-wired host. Every handler is a spy, so a control that renders live
 * but dispatches nothing fails here rather than in a browser.
 */
function host(over: Partial<ControlHost> = {}): ControlHost {
  return {
    kind: 'task',
    ctx,
    capabilitiesOf: () => TASK.capabilities,
    onSetState: vi.fn(),
    onSetValue: vi.fn(),
    onAssign: vi.fn(),
    onArchive: vi.fn(),
    assignableActors: [ADA],
    ...over,
  };
}

function panel(detail: EntityDetail, controls: ControlHost | null, onRestore?: () => void) {
  return render(
    <EntityDetailPanel
      detail={detail}
      reasons={REASONS}
      ctx={ctx}
      controls={controls}
      {...(onRestore ? { onRestore } : {})}
    />,
  );
}

/** A task in whatever work status the case needs. */
function taskAt(workStatus: string, extra: Partial<EntityDetail> = {}): EntityDetail {
  return {
    ...TASK,
    state: { ...TASK.state, workStatus } as EntityDetail['state'],
    ...extra,
  };
}

describe('the panel mounts the real control strip', () => {
  it('the panel mounts a REAL priority control, and it writes priority', () => {
    const h = host();
    const { getByTestId } = panel(TASK, h);

    const select = getByTestId('row-value-select') as HTMLSelectElement;
    // The registry names the field; the panel must not spell it.
    expect(select.dataset.source).toBe('priority');

    fireEvent.change(select, { target: { value: 'low' } });
    // The fourth argument is the control's LABEL, and it is not decoration: a
    // failure notice is user copy, and titling one with `source` produced
    // "priority could not be changed" — lowercase mid-sentence. Both values
    // come off the same registry control, so they cannot disagree.
    expect(h.onSetValue).toHaveBeenCalledWith(TASK.id, 'priority', 'low', 'Priority');
  });

  it('the panel mounts a REAL assignee control, and it writes an EDGE', () => {
    const h = host();
    const { getByTestId, getByRole } = panel(TASK, h);

    fireEvent.click(getByTestId('row-assign-trigger'));
    fireEvent.click(getByRole('button', { name: new RegExp(ADA.displayName) }));

    /**
     * ONE ACTOR, ONE EDGE. `state.assignees` is a PROJECTION of `assigned_to`
     * edges, so assignment is `edges.create` / `edges.delete` per actor and
     * never a whole-collection PUT — a collection write would silently drop an
     * assignment another client made between the read and the write.
     */
    expect(h.onAssign).toHaveBeenCalledWith(TASK.id, ADA.id, 'assigned_to', true);
  });

  it('the strip is registry-driven: a kind with no controls gets none', () => {
    // A doc declares no stateControl, no valueControls and no assignControl.
    const docConfig = getKind('doc');
    expect(docConfig.list.stateControl).toBeUndefined();
    expect(docConfig.list.valueControls ?? []).toHaveLength(0);
    expect(docConfig.list.assignControl).toBeUndefined();

    const doc = Object.values(fixtureDetails).find((d) => d.kind === 'doc');
    if (!doc) throw new Error('the fixtures must carry a doc to exercise this');

    const { queryByTestId } = panel(doc, host({ kind: 'doc' }));
    expect(queryByTestId('row-state-select')).toBeNull();
    expect(queryByTestId('row-value-select')).toBeNull();
    expect(queryByTestId('row-assign-trigger')).toBeNull();
  });

  it('an unwired host refuses VISIBLY rather than hiding the control', () => {
    // L6 / R7: the control is present, dead, and says why. A hidden control
    // would claim the kind has no priority to set, which is a different fact.
    const { getByTestId, queryByTestId } = panel(TASK, host({ onSetValue: undefined }));
    expect(queryByTestId('row-value-select')).toBeNull();
    expect(getByTestId('subtree-body')).toBeTruthy();
    // The refused pill keeps the `data-source` hook so the refusal is assertable.
    expect(document.querySelector('[data-source="priority"]')).not.toBeNull();
  });
});

describe('the way back — done and archived both reopen', () => {
  it('a DONE task can be sent back to open, through the work verb', () => {
    const h = host();
    const { getByTestId } = panel(taskAt('done'), h);

    const select = getByTestId('row-state-select') as HTMLSelectElement;
    expect(select.value).toBe('done');
    // `open` must be OFFERED from done — the registry lists it and nothing
    // filters the list by the current value.
    expect([...select.options].map((o) => o.value)).toContain('open');

    fireEvent.change(select, { target: { value: 'open' } });
    expect(h.onSetState).toHaveBeenCalledWith(TASK.id, 'open', 'set-state');
  });

  it('reopening does NOT route through the completion verb', () => {
    /**
     * The `via` override exists so `done` reaches `complete` (which carries the
     * acceptance-criteria gate and the point award). Every OTHER value —
     * reopening included — must take the plain work verb: `complete` refuses a
     * task that is already done ("task is already complete", 007:1833), so
     * routing a reopen through it would fail on the one path that must work.
     */
    const h = host();
    const { getByTestId } = panel(taskAt('done'), h);
    fireEvent.change(getByTestId('row-state-select'), { target: { value: 'working' } });

    expect(h.onSetState).toHaveBeenCalledWith(TASK.id, 'working', 'set-state');
    expect(h.onSetState).not.toHaveBeenCalledWith(TASK.id, 'working', 'complete');
  });

  it('completing still routes through the gated completion verb', () => {
    const h = host();
    const { getByTestId } = panel(taskAt('working'), h);
    fireEvent.change(getByTestId('row-state-select'), { target: { value: 'done' } });

    // `done` is the ONE value the database refuses on both write doors.
    expect(h.onSetState).toHaveBeenCalledWith(TASK.id, 'done', 'complete');
  });

  it("an ARCHIVED task's Restore button actually restores it", () => {
    const onRestore = vi.fn();
    const archived = taskAt('open', { deletedAt: '2026-08-04T00:00:00.000Z' });

    const { getByTestId } = panel(archived, host(), onRestore);

    fireEvent.click(getByTestId('tombstone-restore'));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('an unwired Restore is disabled-with-reason, never enabled-and-inert', () => {
    /**
     * The regression this pins. `TombstoneBody` drew the button from the day
     * it was written and NO host ever passed `onRestore`, so the one verb an
     * archived entity has rendered as a live-looking button that swallowed the
     * click. That is the exact failure mode L6 exists to forbid.
     */
    const archived = taskAt('open', { deletedAt: '2026-08-04T00:00:00.000Z' });
    const { getByTestId } = panel(archived, host());

    const restore = getByTestId('tombstone-restore');
    expect(restore.tagName).not.toBe('BUTTON');
    expect(restore.closest('[data-testid="panel-tombstone"]')).not.toBeNull();
  });
});

describe('the strip does not duplicate what it replaced', () => {
  /**
   * ONE CONTROL PER STATE. The strip's archive verb belongs to a live entity
   * and the tombstone's restore to a dead one; mounting the strip over a
   * tombstone too would put two restore controls in one panel, which is the
   * duplication D67 removed from the tile in the first place.
   *
   * The two halves are separate cases on purpose: `render()` binds its queries
   * to `document.body`, so two renders in one case would let the first panel
   * answer for the second.
   */
  it('is mounted for a live task', () => {
    expect(panel(TASK, host()).queryByTestId('row-state-select')).not.toBeNull();
  });

  it('is NOT mounted over a tombstone — restore is the only verb there', () => {
    const archived = taskAt('open', { deletedAt: '2026-08-04T00:00:00.000Z' });
    const { queryByTestId } = panel(archived, host());

    expect(queryByTestId('row-state-select')).toBeNull();
    expect(queryByTestId('panel-tombstone')).not.toBeNull();
  });
});
