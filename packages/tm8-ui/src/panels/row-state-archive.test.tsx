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
       * refusal, so a kind that HAS a state and draws nothing still fails.
       *
       * AMENDED 2026-08-18 — "every" NOW MEANS "every kind that has a state".
       * D67's ruling (2026-08-02) was that a state must be settable from every
       * list STYLE; read as "every KIND" it also promised a slot to the 14
       * kinds that have no state, which is what drew a dead `no state` badge
       * on every expanded doc, file, PR and memory row. The user's 2026-08-18
       * ruling — "just taking up height in most places" — removes that slot.
       * The style-reachability half of D67 is untouched and still walked here:
       * task and work_session must draw their control in every anatomy.
       */
      if (getKind(kind).list.stateControl) {
        expect(within(strip).getAllByLabelText(/^Change state/).length).toBeGreaterThan(0);
      } else {
        expect(within(strip).queryAllByLabelText(/^Change state/)).toHaveLength(0);
        expect(strip.querySelector('.lp__statesel--absent')).toBeNull();
      }
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

/**
 * THE COLLAPSED TILE'S STATUS MARK, as a control.
 *
 * USER RULING 2026-08-16: "there is a status button on the task tile, which
 * shows a circle with the status, i am thinking clicking on that should move it
 * to done". The mark was an inert `<span>` — it looked pressable and was not,
 * and a click on it selected the row. It is now the SAME control the expanded
 * strip mounts, in its `dot` anatomy.
 *
 * NOT a one-click `done`, and these tests are where that reasoning is held: the
 * vocabulary has seven values with no transition matrix behind it, and `done`
 * alone carries the acceptance gate, so a mark that only ever wrote `done`
 * would misname itself on six values and refuse on the seventh with nowhere to
 * say why. The menu offers the whole vocabulary and routes each value through
 * the verb that value requires — which is exactly what the select already did.
 */
describe('the collapsed tile writes state through the same control', () => {
  function openTileMenu(): void {
    const trigger = screen.getAllByTestId('row-state-trigger')[0]!;
    // Reachable with the row COLLAPSED: no detail strip has been opened, so
    // this cannot be passing on the expanded strip's control by accident.
    expect(document.querySelectorAll('.lp__rowdetail').length).toBe(0);
    fireEvent.click(trigger);
  }

  it('makes the status mark a real button, not a span that looks like one', () => {
    mount('task', { onSetState: vi.fn() });
    const trigger = screen.getAllByTestId('row-state-trigger')[0]!;
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-haspopup')).toBe('true');
    // The name states the value it is showing, so the fact survives being
    // drawn as a coloured dot.
    expect(trigger.getAttribute('aria-label')).toMatch(/^Change state for .+, currently /);
  });

  it('offers every settable state the registry declares, in registry order', () => {
    mount('task', { onSetState: vi.fn() });
    openTileMenu();
    const offered = screen
      .getAllByTestId('row-state-option')
      .map((o) => o.getAttribute('data-state'));
    expect(offered).toEqual(getKind('task').list.stateControl!.options.map((o) => o.id));
  });

  it('dispatches the ordinary work verb for an ordinary state', () => {
    const onSetState = vi.fn();
    mount('task', { onSetState });
    openTileMenu();
    fireEvent.click(screen.getAllByTestId('row-state-option').find(
      (o) => o.getAttribute('data-state') === 'blocked',
    )!);

    expect(onSetState).toHaveBeenCalledTimes(1);
    const [, next, via] = onSetState.mock.calls[0]!;
    expect(next).toBe('blocked');
    expect(via).toBe('set-state');
  });

  /** The same routing the select holds, from the other anatomy — one control. */
  it('routes `done` through the completion verb, not the work verb', () => {
    const onSetState = vi.fn();
    mount('task', { onSetState });
    openTileMenu();
    fireEvent.click(screen.getAllByTestId('row-state-option').find(
      (o) => o.getAttribute('data-state') === 'done',
    )!);

    const [, next, via] = onSetState.mock.calls[0]!;
    expect(next).toBe('done');
    expect(via).toBe('complete');
  });

  it('marks the current value and writes nothing when it is re-chosen', () => {
    const onSetState = vi.fn();
    const [row] = rowsOfKind('task');
    const current = (row!.state as unknown as { workStatus: string }).workStatus;
    mount('task', { onSetState }, [row!]);
    openTileMenu();

    const chosen = screen.getAllByTestId('row-state-option').filter(
      (o) => o.getAttribute('aria-checked') === 'true',
    );
    expect(chosen.map((o) => o.getAttribute('data-state'))).toEqual([current]);
    fireEvent.click(chosen[0]!);
    expect(onSetState).not.toHaveBeenCalled();
  });

  it('opening the menu does not select the row underneath it', () => {
    const onSelect = vi.fn();
    mount('task', { onSetState: vi.fn(), onSelect });
    openTileMenu();
    expect(onSelect).not.toHaveBeenCalled();
  });

  /**
   * The status word is visually hidden and easy to drop when the mark becomes
   * a control — at which point a status a sighted user reads as a colour is
   * readable to nobody else. It is the row's read-out, so it survives.
   */
  it('keeps the row’s own accessible status word', () => {
    mount('task', { onSetState: vi.fn() });
    const word = document.querySelector('.pn-tt__status-text')?.textContent;
    expect(word).toBeTruthy();
  });

  /**
   * REFUSAL FORM FOLLOWS THE ANATOMY. `DisabledAction`'s caption is a block
   * UNDER the control: correct in the strip, fatal on a 16px mark in a
   * single-line row. The tile must therefore refuse in the TOOLTIP form.
   */
  it.each([
    ['an unwired host', { onSetState: undefined }],
    ['refused edit permission', { onSetState: vi.fn(), capabilitiesOf: () => CAPS_NONE }],
  ])('%s refuses in the tooltip form, without a caption', (_label, over) => {
    mount('task', over);
    expect(screen.queryByTestId('row-state-trigger')).toBeNull();
    const tile = document.querySelector('[data-testid="list-tile"]') as HTMLElement;
    const refused = within(tile).getAllByTestId('disabled-with-reason');
    expect(refused.length).toBeGreaterThan(0);
    expect(tile.querySelector('.pn-tt__main .hon-caption')).toBeNull();
    expect(tile.querySelector('.pn-tt__main .hon-tip')).not.toBeNull();
  });

  it('unloaded capabilities read as CHECKING on the tile too', () => {
    mount('task', { onSetState: vi.fn(), capabilitiesOf: () => undefined });
    expect(screen.queryByTestId('row-state-trigger')).toBeNull();
    expect(screen.getAllByTestId('checking-permission').length).toBeGreaterThan(0);
  });
});

describe('D67 — the three refusals stay distinct', () => {
  /**
   * WAS "a kind with no state field says so, and draws no picker", which
   * pinned a `.lp__statesel--absent` badge reading "no state" in the strip.
   * USER RULING 2026-08-18 removes it: 14 of 19 kinds drew that badge on every
   * expanded row, and it disclosed the absence of a concept the user never
   * reached for. The other three refusals below are unchanged — each of those
   * IS a thing someone tried to do.
   */
  it('a kind with no state field draws no state slot at all', () => {
    // doc carries no state member in the contract's EntityState union.
    mount('doc', { onSetState: vi.fn() });
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-state-select')).toBeNull();
    expect(strip.querySelector('.lp__statesel--absent')).toBeNull();
    // Scoped to the strip: the ROW above it keeps whatever status mark its
    // anatomy draws, which is where the disclosure now lives alone rather
    // than twice. Nothing in the strip claims a state exists or is refused.
    expect(within(strip).queryAllByLabelText(/^Change state/)).toHaveLength(0);
    // ...and the strip is still there, carrying the rest of its controls.
    expect(within(strip).getAllByLabelText(/^(Archive|Restore)$/).length).toBeGreaterThan(0);
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

/**
 * THE CHECKING STATE HAS TO END — the field defect behind "deletion of tasks
 * is not working" (2026-08-12, measured against the prod node in Firefox).
 *
 * `EntityCapabilities` rides on `EntityDetail`; a `collections.query` returns
 * `EntitySummary`. So every control in this strip renders `CheckingPermission`
 * until the host has read that row's DETAIL — the loading vocabulary, whose
 * copy promises "it resolves on its own".
 *
 * On a list row it never did. The only caller of the host's detail read was an
 * OPEN DETAIL PANEL, so a row expanded from the list sat checking forever:
 * state, priority, assignment and Archive were inert `<span>`s that swallowed
 * the click and issued NO request. Measured on prod: five controls still
 * reading "checking permissions" 13s after the expand, and a click on Archive
 * produced not one `/v2` call.
 *
 * The tests above are all about which REFUSAL is right. These are about the
 * one state that is not a refusal at all, and they are what the suite was
 * missing: every one of them passed while the control did nothing.
 */
describe('the expanded row loads the permissions it is waiting on', () => {
  const live = () => rowsOfKind('task').find((r) => r.deletedAt == null)!;

  it('asks the host to load the row detail when capabilities are unknown', () => {
    const onNeedDetail = vi.fn();
    const row = live();
    mount('task', { onArchive: vi.fn(), capabilitiesOf: () => undefined, onNeedDetail }, [row]);
    expandFirstRow();
    expect(onNeedDetail).toHaveBeenCalledWith(row.id);
  });

  /**
   * ONE DELIBERATE EXPAND, ONE ROW. The request rides the MOUNTED strip and
   * not the rendered row, because a detail read per row is a hundred reads on
   * a hundred-row list — the request storm `useGateData`'s claim register
   * exists to prevent. Nothing is expanded here, so nothing is asked.
   */
  it('asks for nothing while every row is collapsed', () => {
    const onNeedDetail = vi.fn();
    mount('task', { onArchive: vi.fn(), capabilitiesOf: () => undefined, onNeedDetail });
    expect(onNeedDetail).not.toHaveBeenCalled();
  });

  it('does not re-ask for a row whose capabilities are already known', () => {
    const onNeedDetail = vi.fn();
    mount('task', { onArchive: vi.fn(), capabilitiesOf: () => CAPS_FULL, onNeedDetail }, [live()]);
    expandFirstRow();
    expect(onNeedDetail).not.toHaveBeenCalled();
  });

  /**
   * THE WHOLE PATH, END TO END: unknown → checking → the answer arrives →
   * Archive is a real button → the click reaches the host. Asserting the
   * request alone would still pass if the strip never redrew on the answer,
   * which is the half-fix this holds the line against.
   */
  it('turns the checking Archive into a live one when the answer lands', () => {
    const onArchive = vi.fn();
    const row = live();
    let caps: typeof CAPS_FULL | undefined;
    const view = mount(
      'task',
      { onArchive, capabilitiesOf: () => caps, onNeedDetail: () => { caps = CAPS_FULL; } },
      [row],
    );

    const checking = expandFirstRow();
    expect(within(checking).getAllByTestId('checking-permission').length).toBeGreaterThan(0);
    expect(within(checking).queryByRole('button', { name: 'Archive' })).toBeNull();

    // The host answered; re-render on the next paint, as a real store update does.
    view.rerender(
      <div className="cv2-root">
        <EntityListPanel
          kind="task"
          rowsFor={() => [row]}
          ctx={ctx}
          onArchive={onArchive}
          capabilitiesOf={() => caps}
          onNeedDetail={() => { caps = CAPS_FULL; }}
        />
      </div>,
    );

    const strip = document.querySelectorAll('.lp__rowdetail')[0] as HTMLElement;
    expect(within(strip).queryAllByTestId('checking-permission')).toHaveLength(0);
    fireEvent.click(within(strip).getByRole('button', { name: 'Archive' }));
    expect(onArchive).toHaveBeenCalledWith('archive', row.id);
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
    /* The SOURCE travels with the write. The host patches `content[source]`,
       so a control that read `priority` and reported something else would
       silently write the wrong field.

       The LABEL travels beside it because a failure notice is user copy, and
       the source is not: titling one with `source` produced "priority could
       not be changed", lowercase mid-sentence. Both come off the same registry
       control, so they cannot drift apart. */
    const control = getKind('task').list.valueControls![0]!;
    expect(onSetValue.mock.calls[0]!.slice(1)).toEqual(['priority', 'high', control.label]);
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

  /**
   * THE FOURTH ARM, and the one that separates "not yet known" from "no".
   *
   * Undefined capabilities mean the detail has not hydrated, not that the
   * viewer was refused — and the difference is load-bearing here, because the
   * host's `setValue` reads its `expectedVersion` from that same cached detail
   * (`useRowLifecycle.ts`). A control that fell through to `DisabledAction`
   * would tell a user with full rights they may not edit; one that fell
   * through to the LIVE select would dispatch a write with no version behind
   * it. Checking is the only honest reading of an absent answer.
   */
  it('reads unloaded capabilities as CHECKING, not as refused and not as live', () => {
    mount('task', { onSetValue: vi.fn(), capabilitiesOf: () => undefined });
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-value-select')).toBeNull();
    const checking = within(strip).getAllByTestId('checking-permission');
    expect(checking.length).toBeGreaterThan(0);
    // Named for THIS control, so the two chips' checking states stay tellable
    // apart in a strip that draws both.
    const label = getKind('task').list.valueControls![0]!.label.toLowerCase();
    expect(checking.some((el) => el.getAttribute('aria-label')?.includes(`Change ${label}`))).toBe(true);
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

  /**
   * NOT-WIRED IS ITS OWN REFUSAL, and a roster does not substitute for a host.
   * Injecting `assignableActors` without `onAssign` is the shape a half-wired
   * call site actually has, and a menu drawn over it would open, toggle, and
   * write nothing — which is precisely the defect this whole strip exists to
   * repair. The refusal has to come BEFORE the roster is consulted.
   */
  it('refuses as not-wired when no host is listening, even with a full roster', () => {
    mount('task', { assignableActors: [ADA, BEE] });
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-assign-trigger')).toBeNull();
    expect(within(strip).getAllByTestId('disabled-with-reason').length).toBeGreaterThan(0);
    // Not the roster's refusal: nothing is missing from the roster here.
    expect(strip.textContent).not.toMatch(/has not loaded/i);
  });

  /**
   * The same fourth arm as the value control's, for the same reason: an absent
   * capability answer is "still loading", and reporting it as `cannotLink`
   * would tell a user who may assign that they may not.
   */
  it('reads unloaded capabilities as CHECKING, not as the link refusal', () => {
    withRoster({ capabilitiesOf: () => undefined });
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-assign-trigger')).toBeNull();
    const checking = within(strip).getAllByTestId('checking-permission');
    expect(checking.some((el) => el.getAttribute('aria-label')?.includes('Change assignment'))).toBe(true);
    expect(strip.textContent).not.toMatch(/link/i);
  });

  it('shows who is assigned even while refusing to change it', () => {
    const live = rowsOfKind('task').find((r) => r.deletedAt == null)!;
    const assigned = { ...live, state: { ...live.state, assignees: [ADA] } } as EntitySummary;
    mount('task', { capabilitiesOf: () => CAPS_NONE, assignableActors: [ADA] }, [assigned]);
    const strip = expandFirstRow();
    expect(strip.textContent).toContain('Ada');
  });
});

/**
 * ===========================================================================
 * W1 (2026-08-16) — the axis chips write `state.axes`, per-space data.
 *
 * THE GAP THESE CLOSE. Every space is seeded a `type` axis and the database
 * enforces it strictly — and 0 of 200 tasks carried a value, because nothing
 * in the product could write one. The picker below is that write. Its
 * vocabulary is NOT registry config: the host hands the space's own
 * `task_axes` rows over as `taskAxes`, so a space with two axes draws two
 * pickers and a space with none draws none — asserted here, because an empty
 * picker over a fabricated taxonomy is the L6 lie.
 * ===========================================================================
 */
describe('the axis chips write per-space axes', () => {
  const TYPE_AXIS = {
    id: 'axis-type',
    spaceId: FIXTURE_SPACE_ID,
    name: 'type',
    axisValues: ['default', 'code', 'design', 'review', 'test'],
    kind: 'default' as const,
    position: 0,
  };

  const taskWithAxes = (axes: Record<string, string>) => {
    const live = rowsOfKind('task').find((r) => r.deletedAt == null)!;
    return { ...live, state: { ...live.state, axes } } as EntitySummary;
  };

  it('dispatches onSetAxis with the axis NAME the space declared', () => {
    const onSetAxis = vi.fn();
    const row = taskWithAxes({});
    mount('task', { onSetAxis, taskAxes: [TYPE_AXIS] }, [row]);
    expandFirstRow();

    const select = screen.getAllByTestId('row-axis-select')[0] as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'code' } });

    expect(onSetAxis).toHaveBeenCalledTimes(1);
    expect(onSetAxis.mock.calls[0]).toEqual([row.id, 'type', 'code', 'Type']);
  });

  it('clears back to unset as an explicit null — unset is a REACHABLE state here', () => {
    const onSetAxis = vi.fn();
    mount('task', { onSetAxis, taskAxes: [TYPE_AXIS] }, [taskWithAxes({ type: 'design' })]);
    expandFirstRow();

    const select = screen.getAllByTestId('row-axis-select')[0] as HTMLSelectElement;
    expect(select.value).toBe('design');
    fireEvent.change(select, { target: { value: '' } });
    expect(onSetAxis).toHaveBeenCalledWith(expect.any(String), 'type', null, 'Type');
  });

  it('offers exactly the axis vocabulary in axisValues order, behind a live clear option', () => {
    mount('task', { onSetAxis: vi.fn(), taskAxes: [TYPE_AXIS] }, [taskWithAxes({})]);
    expandFirstRow();
    const select = screen.getAllByTestId('row-axis-select')[0] as HTMLSelectElement;
    const options = [...select.options];
    // The FIRST option is the clear — enabled, unlike priority's disabled
    // empty marker, because clearing an axis is a legal write.
    expect(options[0]!.value).toBe('');
    expect(options[0]!.disabled).toBe(false);
    expect(options.slice(1).map((o) => o.value)).toEqual(TYPE_AXIS.axisValues);
  });

  it('a space with NO axes renders no axis control and no empty scaffolding', () => {
    mount('task', { onSetAxis: vi.fn(), taskAxes: [] }, [taskWithAxes({})]);
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-axis-select')).toBeNull();
    expect(strip.querySelector('[data-source^="axis:"]')).toBeNull();
  });

  it('two axes draw two pickers — the control count is the space’s, not the registry’s', () => {
    const SIZE_AXIS = { ...TYPE_AXIS, id: 'axis-size', name: 'size', kind: 'manual' as const, axisValues: ['s', 'm', 'l'], position: 1 };
    mount('task', { onSetAxis: vi.fn(), taskAxes: [TYPE_AXIS, SIZE_AXIS] }, [taskWithAxes({})]);
    expandFirstRow();
    expect(screen.getAllByTestId('row-axis-select')).toHaveLength(2);
  });

  /**
   * `axisValues: []` means FREE TEXT per the DB's own comment (001:537-550).
   * A picker cannot offer an open vocabulary, so it refuses with that reason
   * — an EMPTY select would read as "no legal values", the opposite of what
   * the axis means. The CLI (`tm8 task axis`) is the free-text write path.
   */
  it('refuses a free-text axis with the reason named, never an empty picker', () => {
    const FREE_AXIS = { ...TYPE_AXIS, id: 'axis-note', name: 'note', kind: 'manual' as const, axisValues: [] };
    mount('task', { onSetAxis: vi.fn(), taskAxes: [FREE_AXIS] }, [taskWithAxes({ note: 'urgent-q3' })]);
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-axis-select')).toBeNull();
    // The refusal still SHOWS the stored value — hiding the fact with the
    // control would make the refusal a data hole.
    expect(strip.querySelector('[data-source="axis:note"]')?.textContent).toBe('urgent-q3');
  });

  /**
   * A stored value outside today's vocabulary: the truth is shown, and only
   * the vocabulary is offerable — the same honesty rule as priority's unset.
   */
  it('shows a stored value outside today’s vocabulary as the truth, not as a choice', () => {
    mount('task', { onSetAxis: vi.fn(), taskAxes: [TYPE_AXIS] }, [taskWithAxes({ type: 'retired-value' })]);
    expandFirstRow();
    const select = screen.getAllByTestId('row-axis-select')[0] as HTMLSelectElement;
    expect(select.value).toBe('retired-value');
    const stale = [...select.options].find((o) => o.value === 'retired-value');
    expect(stale?.disabled).toBe(true);
  });

  it('refuses as not-wired when no host is listening, still showing the value', () => {
    mount('task', { taskAxes: [TYPE_AXIS] }, [taskWithAxes({ type: 'code' })]);
    const strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-axis-select')).toBeNull();
    expect(strip.querySelector('[data-source="axis:type"]')?.textContent).toBe('code');
  });

  it('reads unloaded capabilities as CHECKING, refused edit as the edit reason', () => {
    mount('task', { onSetAxis: vi.fn(), taskAxes: [TYPE_AXIS], capabilitiesOf: () => undefined }, [taskWithAxes({})]);
    let strip = expandFirstRow();
    expect(
      within(strip)
        .getAllByTestId('checking-permission')
        .some((el) => el.getAttribute('aria-label')?.includes('Change type')),
    ).toBe(true);

    document.body.innerHTML = '';
    mount('task', { onSetAxis: vi.fn(), taskAxes: [TYPE_AXIS], capabilitiesOf: () => CAPS_NONE }, [taskWithAxes({})]);
    strip = expandFirstRow();
    expect(within(strip).queryByTestId('row-axis-select')).toBeNull();
    expect(strip.querySelector('[data-source="axis:type"]')).not.toBeNull();
  });
});
