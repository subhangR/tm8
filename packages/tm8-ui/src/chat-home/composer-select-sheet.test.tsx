// @vitest-environment jsdom
/**
 * THE PHONE'S THREAD-SETTING SHEET, AND THE ONE DEFECT NO PIXEL CAN SHOW.
 *
 * `ComposerSelect` draws its options in a portalled anchored menu on the
 * desktop and in a `MobileSheet` on the phone (shell contract §4 — an anchored
 * popover solved around a small trigger does not survive a 390px frame,
 * especially one shortened by the soft keyboard).
 *
 * ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
 *
 * Moving the menu into a sheet silently broke SELECTING from it, and the way
 * it broke is the reason this is a unit test rather than a capture.
 *
 * `useDismissable` closes on a `pointerdown` outside every MOUNTED ref. With
 * the anchored menu unrendered on the phone, `menuRef.current` is null, so
 * "outside" collapses to "outside the trigger" — and the sheet portals into
 * the frame's sheet host, which is outside the trigger BY CONSTRUCTION. So the
 * `pointerdown` half of a tap dismissed the sheet, the sheet unmounted, and
 * the `click` that would have chosen the option landed on nothing.
 *
 * The result is a control that renders, highlights, accepts the press and does
 * nothing — which the shell contract's honesty rule names from the other
 * direction ("absent handler ⇒ absent control, never a live-looking one that
 * swallows the press").
 *
 * ── AND WHY NO INSTRUMENT IN THIS PROGRAM WOULD HAVE CAUGHT IT ─────────────
 *
 * The row measures 44x44, so the tap census passes. Nothing goes past the
 * right edge, so the overflow measure passes. A screenshot shows a correctly
 * drawn sheet with correctly sized rows. Every artifact the build service
 * produces would have reported this fixed. **A screenshot cannot show that a
 * tap did not take**, which is the same blind spot DEF-037 records for
 * vertical clipping, on a different axis.
 *
 * So the witness for this one cannot be a pixel, and a test is the honest
 * substitute rather than belt-and-braces.
 *
 * ── THE TAP IS FIRED AS pointerdown-THEN-click, DELIBERATELY ───────────────
 *
 * `fireEvent.click` alone would pass against the BROKEN code, because the bug
 * lives entirely in the ordering: it is the `pointerdown` arriving first that
 * unmounts the row the `click` was going to. A test that only clicks proves
 * the handler is wired and proves nothing about whether a finger can reach it
 * — one more measurement answering a question nobody asked it. `useDismissable`
 * listens for `pointerdown` precisely because iOS often synthesises no mouse
 * event at all (see its docblock), so this ordering IS the phone's real one.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ComposerSelect } from './ComposerSelect';
import { MobileSurfaceProvider } from '../mobile';

const OPTIONS = [
  { id: 'plan', label: 'Plan', hint: 'think first' },
  { id: 'build', label: 'Build', hint: 'make changes' },
];

/**
 * The phone arrangement, as `MobileShell` builds it: a real sheet host node in
 * the document, handed to the provider. `MobileSheet` returns null without one,
 * so a provider given `null` would silently exercise NO sheet at all and this
 * whole file would pass by rendering nothing — the absence-as-health shape.
 * The host is asserted below rather than assumed.
 */
function renderOnPhone(onChange: (id: string) => void) {
  const sheetHost = document.createElement('div');
  document.body.appendChild(sheetHost);
  const view = render(
    <MobileSurfaceProvider sheetHost={sheetHost}>
      <ComposerSelect
        label="Chat mode"
        testId="tch-mode"
        options={OPTIONS}
        value="plan"
        onChange={onChange}
        emptyNote="No chat mode is available."
      />
    </MobileSurfaceProvider>,
  );
  return { ...view, sheetHost };
}

describe('ComposerSelect on the phone', () => {
  it('opens a sheet rather than an anchored menu', () => {
    const { getByTestId, queryByTestId } = renderOnPhone(vi.fn());

    fireEvent.click(getByTestId('tch-mode'));

    /* The POSITIVE witness: the sheet actually mounted. Without this the test
       below could pass on a screen where nothing opened at all. */
    expect(getByTestId('tch-mode-sheet')).toBeTruthy();
    /* And the anchored menu is NOT also drawn — two open surfaces for one
       control is its own defect. */
    expect(queryByTestId('tch-mode-menu')).toBeNull();
  });

  it('SELECTS on a real tap — pointerdown must not dismiss the sheet before the click lands', () => {
    const onChange = vi.fn();
    const { getByTestId } = renderOnPhone(onChange);

    fireEvent.click(getByTestId('tch-mode'));
    const option = getByTestId('tch-mode-build');

    /* A TAP, IN THE ORDER A FINGER PRODUCES IT. This is the assertion; the
       click alone would pass against the bug. */
    fireEvent.pointerDown(option);
    fireEvent.click(option);

    expect(onChange).toHaveBeenCalledWith('build');
  });

  it('still dismisses by the sheet\'s own routes, so turning the hook off cost nothing', () => {
    const { getByTestId, queryByTestId } = renderOnPhone(vi.fn());

    fireEvent.click(getByTestId('tch-mode'));
    expect(getByTestId('tch-mode-sheet')).toBeTruthy();

    /* Escape is `MobileSheet`'s, bound at the document in the capture phase.
       Asserting it here is what makes the previous test's fix legitimate rather
       than a dismissal behaviour quietly deleted: the hook is off on the phone
       BECAUSE the sheet already owns every exit, and that claim is checkable. */
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByTestId('tch-mode-sheet')).toBeNull();
  });
});

describe('ComposerSelect off the phone', () => {
  /**
   * The desktop path must be untouched — there is no provider here, so
   * `useMobileSurface()` returns `DESKTOP` (`oneSurface: false`) and every
   * phone branch is unreachable by construction rather than by a selector
   * somebody has to keep correct.
   */
  it('draws no sheet and keeps the anchored menu', () => {
    const { getByTestId, queryByTestId } = render(
      <ComposerSelect
        label="Chat mode"
        testId="tch-mode"
        options={OPTIONS}
        value="plan"
        onChange={vi.fn()}
        emptyNote="No chat mode is available."
      />,
    );

    fireEvent.click(getByTestId('tch-mode'));

    expect(queryByTestId('tch-mode-sheet')).toBeNull();
    /* `MobileSheet` renders null with a null `sheetHost`, so the absence above
       is guaranteed even if the branch were wrong. The load-bearing half is
       that the DESKTOP surface is still there. */
    expect(getByTestId('tch-mode-menu')).toBeTruthy();
  });
});
