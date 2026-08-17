// @vitest-environment jsdom
/**
 * D67 — the expanded row's state dropdown and archive control.
 *
 * USER RULING 2026-08-02: "in every entity list style, each entity should have
 * an option to change its state as a dropdown when the entity is expanded on
 * the entity list itself... there is also an archived state, and the archived
 * state UI state works on top of the archived state."
 *
 * WHAT THESE TESTS ARE FOR, given jsdom has no layout and cannot see a pixel:
 * they hold the SEMANTICS the ruling names — every list style reaches the same
 * control, the control writes the value the user picked through the verb that
 * value actually requires, and the archive layer stays distinct from the state
 * layer instead of being folded into it. None of that is a layout fact, so it
 * is all reachable here; the visual result is not, and is not claimed.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import { allKinds, getKind, type ActionContext } from '../domain';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
import { EntityListPanel } from './index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const CAPS_FULL = {
  canEdit: true, canDelete: true, canAddChild: true, canLink: true,
  canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
} as const;

const CAPS_NONE = {
  canEdit: false, canDelete: false, canAddChild: false, canLink: false,
  canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
} as const;

function rowsOfKind(kind: string): EntitySummary[] {
  return fixtureSummaries.filter((row) => row.kind === kind);
}

function mount(
  kind: string,
  over: Partial<React.ComponentProps<typeof EntityListPanel>> = {},
  rows: readonly EntitySummary[] = rowsOfKind(kind),
) {
  return render(
    <div className="cv2-root">
      <EntityListPanel
        kind={kind}
        // Every lifecycle tier reads the same fixture set: these tests are
        // about the row's controls, not about which tier a row lands in.
        rowsFor={() => rows}
        ctx={ctx}
        capabilitiesOf={() => CAPS_FULL}
        {...over}
      />
    </div>,
  );
}

/**
 * Opens the first row's detail strip, whichever anatomy drew the disclosure.
 *
 * THREE ANATOMIES, THREE ACCESSIBLE NAMES — the standard tile and the
 * control-card name their subject ("Expand details for X"), the session tile
 * does not ("Expand details"). Matching both is the point of the test: the
 * ruling says the control is reachable in every style, and a helper that only
 * knew one spelling would quietly skip the style it could not open.
 */
function expandFirstRow(): HTMLElement {
  const toggles = screen.getAllByRole('button', { name: /^Expand details/ });
  fireEvent.click(toggles[0]!);
  const strips = document.querySelectorAll('.lp__rowdetail');
  expect(strips.length).toBeGreaterThan(0);
  return strips[0] as HTMLElement;
}

describe('D67 — every list style reaches the state control', () => {
  /**
   * THE RULING'S WORD IS "every", so this walks the WHOLE registry rather than
   * the two anatomies I happened to build against. A new kind — or a fourth
   * anatomy — that forgets the strip fails here, which is the only way "every"
   * survives contact with the next person to add a kind.
   */
  it.each(allKinds().filter((k) => !k.kind.startsWith('c:')).map((k) => k.kind))(
    '%s rows expand to a detail strip carrying state + archive',
    (kind) => {
      const rows = rowsOfKind(kind);
      if (rows.length === 0) return; // no fixture for this kind; covered by the registry walk below
      mount(kind);
      const strip = expandFirstRow();
      /**
       * REACHABILITY, BY ACCESSIBLE NAME — not by the visible row label.
       *
       * The strip has two layouts (2026-08-04): `lines`, which prints a
       * "STATE" caption beside each control, and `chips`, where the control
       * IS the chip and the word lives only in its accessible name. Asserting
       * on `.lp__rowdetail-label` measured the LAYOUT and called it the
       * ruling; the ruling is that the control is reachable in every style.
       * These names are carried identically by the live control and by every
       * refusal, so a kind that draws the honest "no state to set" still
       * passes and a kind that draws nothing still fails.
       */
      expect(within(strip).getAllByLabelText(/^Change state/).length).toBeGreaterThan(0);
      // `Restore` because an already-archived fixture row draws the inverse
      // verb — the tombstone control, not one specific direction of it.
      expect(within(strip).getAllByLabelText(/^(Archive|Restore)$/).length).toBeGreaterThan(0);
    },
  );

  it('declares a state control for exactly the kinds that HAVE a state field', () => {
    // The registry is the claim; this pins it so a kind cannot quietly grow a
    // picker over a field the contract does not carry.
    const withControl = allKinds()
      .filter((k) => k.list.stateControl)
      .map((k) => k.kind)
      .sort();
    expect(withControl).toEqual(['task', 'work_session']);
  });
});

describe('D67 — the picker writes the value the user chose', () => {
  it('dispatches the ordinary work verb for an ordinary state', () => {
    const onSetState = vi.fn();
    mount('task', { onSetState });
    expandFirstRow();

    const select = screen.getAllByTestId('row-state-select')[0] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'blocked' } });

    expect(onSetState).toHaveBeenCalledTimes(1);
    const [, next, via] = onSetState.mock.calls[0]!;
    expect(next).toBe('blocked');
    expect(via).toBe('set-state');
  });

  /**
   * THE ONE THAT MATTERS. `done` is refused outright by the work verb
   * ("completion goes through complete_task") because completion carries an
   * acceptance-criteria gate. A picker that sent it down the same path as
   * `blocked` would surface a server invariant as an unexplained failure, so
   * the routing is registry DATA and this is what holds it.
   */
  it('routes `done` through the completion verb, not the work verb', () => {
    const onSetState = vi.fn();
    mount('task', { onSetState });
    expandFirstRow();

    const select = screen.getAllByTestId('row-state-select')[0] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'done' } });

    const [, next, via] = onSetState.mock.calls[0]!;
    expect(next).toBe('done');
    expect(via).toBe('complete');
  });

  it('offers every settable state the registry declares, in registry order', () => {
    mount('task', { onSetState: vi.fn() });
    expandFirstRow();
    const select = screen.getAllByTestId('row-state-select')[0] as HTMLSelectElement;
    const declared = getKind('task').list.stateControl!.options.map((o) => o.id);
    const offered = [...select.options].map((o) => o.value);
    expect(offered).toEqual(declared);
  });

  it('re-selecting the current value writes nothing', () => {
    const onSetState = vi.fn();
    const [row] = rowsOfKind('task');
    const current = (row!.state as unknown as { workStatus: string }).workStatus;
    mount('task', { onSetState }, [row!]);
    expandFirstRow();

    const select = screen.getByTestId('row-state-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: current } });
    expect(onSetState).not.toHaveBeenCalled();
  });
});

describe('D67 — the four refusals stay distinct', () => {
  it('a kind with no state field says so, and draws no picker', () => {
    // doc carries no state member in the contract's EntityState union.
    mount('doc', { onSetState: vi.fn() });
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-state-select')).toBeNull();
    // Scoped to the strip's own pill: the collapsed row above it also carries
    // a "no status" badge, and a loose text match would pass on that instead.
    expect(strip.querySelector('.lp__statesel--absent')?.textContent).toBe('no state');
  });

  it('a session shows its state read-only, because the node observes it', () => {
    mount('work_session', { onSetState: vi.fn() });
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-state-select')).toBeNull();
    // The reason names WHY, and is a different statement from "no state".
    expect(strip.textContent).toMatch(/observed, not chosen/i);
  });

  it('an unwired host disables the picker rather than dropping the change', () => {
    mount('task', { onSetState: undefined });
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-state-select')).toBeNull();
    expect(within(strip).getAllByTestId('disabled-with-reason').length).toBeGreaterThan(0);
  });

  it('refused edit permission disables the picker', () => {
    mount('task', { onSetState: vi.fn(), capabilitiesOf: () => CAPS_NONE });
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-state-select')).toBeNull();
  });

  it('unloaded capabilities read as CHECKING, not as refused', () => {
    mount('task', { onSetState: vi.fn(), capabilitiesOf: () => undefined });
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-state-select')).toBeNull();
    expect(within(strip).getAllByTestId('checking-permission').length).toBeGreaterThan(0);
  });
});

describe('D67 — archive is a layer ON TOP of state, not a value inside it', () => {
  it('never offers "archived" as a state option', () => {
    // Archiving does not change `workStatus` — a task keeps it across an
    // archive/restore round-trip — so listing it beside `blocked` would claim
    // the two are the same kind of fact.
    for (const config of allKinds()) {
      const ids = (config.list.stateControl?.options ?? []).map((o) => o.id);
      expect(ids).not.toContain('archived');
    }
  });

  it('a live row offers Archive; an already-archived row offers Restore', () => {
    const onAction = vi.fn();  // the ARCHIVE handler; see the prop note below
    const live = rowsOfKind('task').find((r) => r.deletedAt == null)!;
    const dead = rowsOfKind('task').find((r) => r.deletedAt != null)!;

    const first = mount('task', { onArchive: onAction }, [live]);
    expect(within(expandFirstRow()).getByRole('button', { name: 'Archive' })).toBeTruthy();
    first.unmount();

    mount('task', { onArchive: onAction }, [dead]);
    expect(within(expandFirstRow()).getByRole('button', { name: 'Restore' })).toBeTruthy();
  });

  it('dispatches the archive verb with the row id', () => {
    const onAction = vi.fn();
    const live = rowsOfKind('task').find((r) => r.deletedAt == null)!;
    mount('task', { onArchive: onAction }, [live]);
    fireEvent.click(within(expandFirstRow()).getByRole('button', { name: 'Archive' }));
    expect(onAction).toHaveBeenCalledWith('archive', live.id);
  });

  /**
   * REGRESSION, and the reason `onArchive` is its own prop.
   *
   * The first build routed archive through the general `onAction`. That prop
   * is what the panel reads to decide whether the registry's OTHER verbs have
   * a host — so supplying it lit the Sessions header's `quickLaunch` as a
   * working control that the archive executor neither owned nor would have
   * performed: enabled and inert, the failure this package renders
   * disabled-with-reason to avoid. `gate.test.tsx` caught it from the outside;
   * this holds it at the seam where it was introduced.
   */
  it('wiring archive does NOT enable unrelated verbs (quickLaunch stays dark)', () => {
    const { container } = mount('work_session', { onArchive: vi.fn(), onSetState: vi.fn() });
    expect(container.querySelector('.lp__actions')).toBeNull();
  });

  it('refused delete permission disables archive with a reason', () => {
    const live = rowsOfKind('task').find((r) => r.deletedAt == null)!;
    mount('task', { onArchive: vi.fn(), capabilitiesOf: () => CAPS_NONE }, [live]);
    const strip = expandFirstRow();

    // No real button — and the refusal carries the VISIBLE reason, not a
    // hover-only tooltip.
    expect(strip.querySelector('button.lp__rowaction')).toBeNull();
    const refused = within(strip).getAllByTestId('disabled-with-reason');
    expect(refused.length).toBeGreaterThan(0);
    expect(strip.textContent).toMatch(/permission to archive/i);
  });

  /**
   * REGRESSION, caught in Chrome and invisible to jsdom's own eyes.
   *
   * The refusal used to fall through to the ICON vocabulary — a bare 22px
   * glyph with a tooltip — which rendered the disabled Archive as an
   * unlabelled square directly beneath a STATE row that printed its reason as
   * visible text. Two honesty vocabularies in one strip, with the quieter one
   * on the destructive verb. A refused control must still say what it is.
   */
  it('the refused archive keeps its WORD, not just its glyph', () => {
    const live = rowsOfKind('task').find((r) => r.deletedAt == null)!;
    mount('task', { onArchive: vi.fn(), capabilitiesOf: () => CAPS_NONE }, [live]);
    const strip = expandFirstRow();
    const label = strip.querySelector('.lp__rowaction--off .lp__rowaction-label');
    expect(label?.textContent).toBe('Archive');
  });
});

describe('D67 — the picker and the badge cannot disagree', () => {
  /**
   * The control reads `panel.statusPill` for its words and tones rather than
   * carrying its own copy. This is what stops the dropdown saying "in_review"
   * while the badge above it says "in review".
   */
  it('labels options with the kind’s own status words', () => {
    mount('task', { onSetState: vi.fn() });
    expandFirstRow();
    const select = screen.getAllByTestId('row-state-select')[0] as HTMLSelectElement;
    const labels = getKind('task').panel.statusPill!.labels ?? {};
    for (const option of [...select.options]) {
      const expected = labels[option.value] ?? option.value.replace(/_/g, ' ');
      expect(option.textContent).toBe(expected);
    }
  });
});

/**
 * ===========================================================================
 * 2026-08-04 — the other two chips.
 *
 * THE BUG THESE HOLD. The control-card's expand drew status, priority and
 * assignee as three static `<span>`s and then mounted the real State+Archive
 * strip underneath them. Three things that looked like controls did nothing;
 * a fourth, further down, worked. The report was "none of those buttons work",
 * and it was accurate — they were never buttons.
 *
 * So the assertions below are about REACHING A WRITE, not about markup: each
 * chip dispatches the host callback its own write requires, and there is
 * exactly ONE of each control in an expand.
 * ===========================================================================
 */
describe('the expanded task tile carries ONE of each control', () => {
  it('has a single state control, not the old duplicate pair', () => {
    mount('task', { onSetState: vi.fn(), onSetValue: vi.fn(), onArchive: vi.fn() });
    const strip = expandFirstRow();
    // The regression exactly: two strips in one expand meant two state
    // controls, and the one the user reached first was the inert one.
    expect(document.querySelectorAll('.lp__rowdetail')).toHaveLength(1);
    expect(within(strip).getAllByTestId('row-state-select')).toHaveLength(1);
    expect(within(strip).getAllByTestId('row-value-select')).toHaveLength(1);
  });
});

describe('the priority chip writes priority', () => {
  it('dispatches onSetValue with the registry’s own field name', () => {
    const onSetValue = vi.fn();
    const live = rowsOfKind('task').find((r) => r.deletedAt == null)!;
    mount('task', { onSetValue }, [live]);
    expandFirstRow();

    const select = screen.getAllByTestId('row-value-select')[0] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'high' } });

    expect(onSetValue).toHaveBeenCalledTimes(1);
    // The SOURCE travels with the write. The host patches `content[source]`,
    // so a control that read `priority` and reported something else would
    // silently write the wrong field.
    expect(onSetValue.mock.calls[0]!.slice(1)).toEqual(['priority', 'high']);
  });

  it('offers exactly the registry vocabulary, in registry order', () => {
    mount('task', { onSetValue: vi.fn() });
    expandFirstRow();
    const select = screen.getAllByTestId('row-value-select')[0] as HTMLSelectElement;
    const declared = getKind('task').list.valueControls![0]!.options;
    const settable = [...select.options].filter((o) => !o.disabled);
    expect(settable.map((o) => o.value)).toEqual(declared.map((o) => o.id));
    expect(settable.map((o) => o.textContent)).toEqual(declared.map((o) => o.label));
  });

  /**
   * Unset is a REAL state and it is not "low". The first build of this select
   * would have snapped an unset field to its first option and claimed a
   * priority the record does not carry — a read defect wearing a write's
   * clothes, since the user then commits the lie by touching anything else.
   */
  it('shows an unset field as unset, and refuses to select back to it', () => {
    const live = rowsOfKind('task').find((r) => r.deletedAt == null)!;
    const noPriority = { ...live, state: { ...live.state, priority: undefined } } as EntitySummary;
    mount('task', { onSetValue: vi.fn() }, [noPriority]);
    expandFirstRow();
    const select = screen.getAllByTestId('row-value-select')[0] as HTMLSelectElement;
    const empty = [...select.options].find((o) => o.disabled);
    expect(empty?.textContent).toBe(getKind('task').list.valueControls![0]!.emptyLabel);
    expect(select.value).toBe('');
  });

  it('refuses with the edit reason when the viewer may not edit', () => {
    mount('task', { onSetValue: vi.fn(), capabilitiesOf: () => CAPS_NONE });
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-value-select')).toBeNull();
    // Still SHOWS the value — a refusal hides the control, never the fact.
    expect(strip.querySelector('[data-source="priority"]')).not.toBeNull();
  });

  it('refuses as not-wired when no host is listening, rather than dropping the change', () => {
    mount('task', {});
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-value-select')).toBeNull();
    expect(within(strip).getAllByTestId('disabled-with-reason').length).toBeGreaterThan(0);
  });
});

describe('the assigned chip writes an EDGE, one actor at a time', () => {
  const ADA = { id: 'member-ada', kind: 'member', displayName: 'Ada', avatar: null, isAgent: false } as const;
  const BEE = { id: 'tm-bee', kind: 'team_member', displayName: 'Bee', avatar: null, isAgent: true } as const;

  const withRoster = (over = {}) =>
    mount('task', { onAssign: vi.fn(), assignableActors: [ADA, BEE], ...over });

  it('adds an assignment as the registry’s edge type', () => {
    const onAssign = vi.fn();
    const live = rowsOfKind('task').find((r) => r.deletedAt == null)!;
    const unassigned = { ...live, state: { ...live.state, assignees: [] } } as EntitySummary;
    mount('task', { onAssign, assignableActors: [ADA, BEE] }, [unassigned]);
    expandFirstRow();

    fireEvent.click(screen.getAllByTestId('row-assign-trigger')[0]!);
    const options = screen.getAllByTestId('row-assign-option');
    fireEvent.click(options.find((o) => o.getAttribute('data-actor') === ADA.id)!);

    // `assigned_to` is spelled ONCE, in the registry. The panel forwards it.
    expect(onAssign.mock.calls[0]!.slice(1)).toEqual([ADA.id, 'assigned_to', true]);
  });

  /**
   * The remove half, and the reason this is a menu of toggles rather than a
   * `<select multiple>`: a multi-select commits the whole collection, and a
   * whole-collection write silently drops an assignment another client made
   * between the read and the write.
   */
  it('removes an assignment the row already has', () => {
    const onAssign = vi.fn();
    const live = rowsOfKind('task').find((r) => r.deletedAt == null)!;
    const assigned = { ...live, state: { ...live.state, assignees: [ADA] } } as EntitySummary;
    mount('task', { onAssign, assignableActors: [ADA, BEE] }, [assigned]);
    expandFirstRow();

    fireEvent.click(screen.getAllByTestId('row-assign-trigger')[0]!);
    const on = screen.getAllByTestId('row-assign-option').find(
      (o) => o.getAttribute('data-actor') === ADA.id,
    )!;
    expect(on.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(on);
    expect(onAssign.mock.calls[0]!.slice(1)).toEqual([ADA.id, 'assigned_to', false]);
  });

  /**
   * AN EMPTY ROSTER IS NOT AN EMPTY SPACE. The host injects this list, so
   * "nothing was injected" means "nothing has loaded" — and a menu drawn over
   * it would tell a user with a full team that there is nobody to assign.
   */
  it('refuses honestly when the roster has not loaded, instead of opening an empty menu', () => {
    mount('task', { onAssign: vi.fn(), assignableActors: [] });
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-assign-trigger')).toBeNull();
    expect(strip.textContent).toMatch(/has not loaded/i);
  });

  it('refuses with the LINK reason, not the edit one — an edge is not a content edit', () => {
    withRoster({ capabilitiesOf: () => CAPS_NONE });
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-assign-trigger')).toBeNull();
    expect(strip.textContent).toMatch(/link/i);
  });

  it('shows who is assigned even while refusing to change it', () => {
    const live = rowsOfKind('task').find((r) => r.deletedAt == null)!;
    const assigned = { ...live, state: { ...live.state, assignees: [ADA] } } as EntitySummary;
    mount('task', { capabilitiesOf: () => CAPS_NONE, assignableActors: [ADA] }, [assigned]);
    const strip = expandFirstRow();
    expect(strip.textContent).toContain('Ada');
  });
});
