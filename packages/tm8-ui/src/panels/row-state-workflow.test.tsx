// @vitest-environment jsdom
/**
 * W4 (2026-08-16) — the state control NARROWS under a workflow, and the
 * off-workflow fact is drawn, never repaired.
 *
 * The registry's own ruling (registry.ts, the state-picker docblock): "when a
 * real workflow lands (keyed on the `type` axis, space-scoped like task_axes),
 * it narrows THIS list; the control does not change shape." So these tests
 * hold exactly that:
 *   - a forbidden status renders as a DISABLED option with the reason in its
 *     title — present, named, unclickable — never hidden;
 *   - a row with no `type` value, no rule for its value, or a host with no
 *     workflows at all behaves as today (nothing disabled, nothing drawn);
 *   - a CURRENT status outside the vocabulary is the derived OFF-WORKFLOW
 *     fact: flagged in the honesty-kit caption voice naming type and status,
 *     while the select still shows the true value (never snapped, never
 *     rewritten) — and moving OUT of it stays free.
 *
 * The client narrows for usability only; the DATABASE trigger (132) is the
 * gate, so nothing here predicts a server refusal — it disables what the
 * vocabulary in hand already forbids.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { EntitySummary, TaskWorkflow } from '@tm8/contract';
import type { ActionContext } from '../domain';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
import { EntityListPanel } from './index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const CAPS_FULL = {
  canEdit: true, canDelete: true, canAddChild: true, canLink: true,
  canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
} as const;

/** A rule narrowing `code` to the structural three + in_review: no pulled, no blocked, no cancelled. */
const CODE_RULE: TaskWorkflow = {
  id: 'wf-code',
  spaceId: FIXTURE_SPACE_ID as never,
  typeValue: 'code',
  statuses: ['open', 'working', 'in_review', 'done'] as never,
};

const task = (over: { workStatus?: string; axes?: Record<string, string> }): EntitySummary => {
  const base = fixtureSummaries.find((s) => s.state.kind === 'task' && s.deletedAt == null)!;
  return {
    ...base,
    state: {
      ...base.state,
      ...(over.workStatus !== undefined ? { workStatus: over.workStatus } : {}),
      axes: over.axes ?? {},
    } as EntitySummary['state'],
  };
};

function mount(
  row: EntitySummary,
  over: Partial<React.ComponentProps<typeof EntityListPanel>> = {},
) {
  return render(
    <div className="cv2-root">
      <EntityListPanel
        kind="task"
        rowsFor={() => [row]}
        ctx={ctx}
        capabilitiesOf={() => CAPS_FULL}
        onSetState={() => undefined}
        {...over}
      />
    </div>,
  );
}

function expandFirstRow(): HTMLElement {
  const toggles = screen.getAllByRole('button', { name: /^Expand details/ });
  fireEvent.click(toggles[0]!);
  const strips = document.querySelectorAll('.lp__rowdetail');
  expect(strips.length).toBeGreaterThan(0);
  return strips[0] as HTMLElement;
}

function stateSelect(): HTMLSelectElement {
  return screen.getAllByTestId('row-state-select')[0] as HTMLSelectElement;
}

describe('W4 — the strip select narrows under a workflow, without changing shape', () => {
  it('a forbidden status is a DISABLED option carrying the reason IN ITS LABEL — never hidden', () => {
    mount(task({ workStatus: 'open', axes: { type: 'code' } }), { taskWorkflows: [CODE_RULE] });
    expandFirstRow();

    const options = [...stateSelect().querySelectorAll('option')];
    // The control does not change shape: all seven still render.
    expect(options.map((o) => o.value)).toEqual(
      ['open', 'pulled', 'working', 'in_review', 'blocked', 'done', 'cancelled'],
    );
    const byValue = new Map(options.map((o) => [o.value, o] as const));
    for (const barred of ['pulled', 'blocked', 'cancelled']) {
      expect(byValue.get(barred)!.disabled, `${barred} must be disabled`).toBe(true);
      /* THE REASON IS IN THE OPTION'S TEXT, and it used to be in `title`.
         `title` on an `<option>` is rendered by NO browser — not as a desktop
         tooltip, not in the native picker a phone opens — so that reason was
         unreachable on every platform by every input. Option text is the one
         thing every select renders, so it lives there now. Asserting `title`
         here is what kept the defect alive. */
      expect(byValue.get(barred)!.getAttribute('title')).toBeNull();
      expect(byValue.get(barred)!.textContent).toContain('not in type code');
    }
    for (const allowed of ['open', 'working', 'in_review', 'done']) {
      expect(byValue.get(allowed)!.disabled, `${allowed} must stay live`).toBe(false);
    }
  });

  it('no type value, no rule for the value, or no workflows at all = today exactly', () => {
    const cases: Array<[EntitySummary, readonly TaskWorkflow[] | undefined]> = [
      [task({ workStatus: 'open', axes: {} }), [CODE_RULE]],
      [task({ workStatus: 'open', axes: { type: 'design' } }), [CODE_RULE]],
      [task({ workStatus: 'open', axes: { type: 'code' } }), undefined],
    ];
    for (const [row, workflows] of cases) {
      const view = mount(row, { taskWorkflows: workflows as never });
      expandFirstRow();
      const options = [...stateSelect().querySelectorAll('option')];
      expect(options.some((o) => o.disabled)).toBe(false);
      expect(screen.queryByTestId('row-state-offworkflow')).toBeNull();
      view.unmount();
    }
  });
});

describe('W4 — the OFF-WORKFLOW mark is derived, drawn, and never a repair', () => {
  it('a current status outside the vocabulary draws the caption naming type and status', () => {
    mount(task({ workStatus: 'blocked', axes: { type: 'code' } }), { taskWorkflows: [CODE_RULE] });
    const strip = expandFirstRow();

    const mark = within(strip).getByTestId('row-state-offworkflow');
    expect(mark.textContent).toBe('off workflow — type code does not allow blocked');
    // NEVER REWRITTEN: the select still reports the stored value truthfully.
    expect(stateSelect().value).toBe('blocked');
    // The caption is the honesty kit's voice, not a bespoke style.
    expect(mark.className).toContain('hon-caption');
  });

  it('moving OUT of an off-workflow status is free — the current value never bars itself', () => {
    const onSetState = vi.fn();
    mount(task({ workStatus: 'blocked', axes: { type: 'code' } }), {
      taskWorkflows: [CODE_RULE],
      onSetState,
    });
    expandFirstRow();

    fireEvent.change(stateSelect(), { target: { value: 'working' } });
    expect(onSetState).toHaveBeenCalledTimes(1);
    expect(onSetState.mock.calls[0]![1]).toBe('working');
  });

  it('an in-vocabulary status draws no mark', () => {
    mount(task({ workStatus: 'in_review', axes: { type: 'code' } }), { taskWorkflows: [CODE_RULE] });
    expandFirstRow();
    expect(screen.queryByTestId('row-state-offworkflow')).toBeNull();
  });
});

describe('W4 — the tile dot narrows through the SAME control', () => {
  /** The dot is `RowStateControl` `variant="dot"` on the COLLAPSED tile —
      one control, two anatomies (D67), so the panel mount is the honest one. */
  function openTileMenu(): void {
    const trigger = screen.getAllByTestId('row-state-trigger')[0]!;
    expect(document.querySelectorAll('.lp__rowdetail').length).toBe(0);
    fireEvent.click(trigger);
  }

  it('a forbidden menu row is aria-disabled with the reason, and a click dispatches nothing', () => {
    const onSetState = vi.fn();
    mount(task({ workStatus: 'open', axes: { type: 'code' } }), {
      taskWorkflows: [CODE_RULE],
      onSetState,
    });
    openTileMenu();

    const barred = screen
      .getAllByTestId('row-state-option')
      .find((o) => o.getAttribute('data-state') === 'pulled')!;
    expect(barred.getAttribute('aria-disabled')).toBe('true');
    /* Visible text, not a hover tooltip: a finger produces no hover, so under
       `title` this row was greyed out and mute on touch. */
    expect(barred.getAttribute('title')).toBeNull();
    expect(barred.textContent).toContain('not in type code');
    fireEvent.click(barred);
    expect(onSetState).not.toHaveBeenCalled();

    // An allowed row still dispatches — the narrowing bars, it does not park.
    const allowed = screen
      .getAllByTestId('row-state-option')
      .find((o) => o.getAttribute('data-state') === 'working')!;
    expect(allowed.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(allowed);
    expect(onSetState).toHaveBeenCalledTimes(1);
  });

  it('the off-workflow fact rides the 16px mark as title text — the tile anatomy has no room for a caption', () => {
    mount(task({ workStatus: 'blocked', axes: { type: 'code' } }), {
      taskWorkflows: [CODE_RULE],
      onSetState: vi.fn(),
    });
    const trigger = screen.getAllByTestId('row-state-trigger')[0]!;
    expect(trigger.getAttribute('title')).toContain('off workflow — type code does not allow blocked');
    expect(trigger.getAttribute('aria-label')).toContain('off workflow');
  });
});
