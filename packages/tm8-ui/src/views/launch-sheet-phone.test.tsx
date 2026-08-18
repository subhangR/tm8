// @vitest-environment jsdom
/**
 * THE LAUNCH SHEET'S PHONE ARRANGEMENT — DEF-004.
 *
 * WHAT THIS FILE IS FOR, and what it deliberately does not attempt. jsdom has no
 * layout, so nothing here can tell you the sheet fits at 390 or that its
 * controls clear 44px — those are the build service's, from pixels.
 *
 * What it CAN pin is the part the pixels cannot distinguish:
 *
 *   · that the sheet goes through the FRAME'S HOST rather than drawing its own
 *     desktop popover. A screenshot of a correctly-styled bespoke dialog and a
 *     screenshot of a correctly-styled phone sheet look the same;
 *   · that BOTH witnesses exist and are SEPARATE, so an instrument can answer
 *     "did it mount" and "did it go through the host" as two fields. Collapsing
 *     them is how "it rendered" gets read as "it rendered correctly on a phone";
 *   · that the in-flight guard survives the extra dismissal routes a sheet
 *     brings with it. The desktop sheet disables ✕ and Cancel while launching;
 *     a sheet adds a BACKDROP and an Escape, and a guard wired on the button but
 *     not on those would make the phone the one shell where an outstanding spawn
 *     can be dismissed. That failure is invisible in every test that does not
 *     tap the backdrop.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { LaunchSheet } from './LaunchSheet';
import { MobileSurfaceProvider } from '../mobile';
import { LAUNCH_CAPACITY, LAUNCH_PROFILES, LAUNCH_PROJECTS, LAUNCH_TEAMMATES } from './launch-fixtures';

/**
 * The frame's sheet host, stood up by hand. `MobileShell` renders
 * `<div className="msheet-host" ref={setSheetHost} />` inside `MobileFrame` and
 * hands the NODE down through the surface context; this is that node, and
 * nothing else about the frame is needed to prove the portal lands in it.
 */
function phone(props: Partial<React.ComponentProps<typeof LaunchSheet>> = {}) {
  const host = document.createElement('div');
  host.className = 'msheet-host';
  document.body.append(host);
  const view = render(
    <div className="cv2-root" data-shell="mobile">
      <MobileSurfaceProvider sheetHost={host}>
        <LaunchSheet
          subjectId={'task-1' as EntityId}
          fromChip="◔ Run ▸"
          fromCaption="subject pre-associated — the session links to it"
          teammates={LAUNCH_TEAMMATES}
          projects={LAUNCH_PROJECTS}
          profiles={LAUNCH_PROFILES}
          capacity={LAUNCH_CAPACITY}
          onLaunch={() => {}}
          onCancel={() => {}}
          {...props}
        />
      </MobileSurfaceProvider>
    </div>,
  );
  return { ...view, host };
}

describe('LaunchSheet on a phone', () => {
  it('goes through the frame’s sheet host, and reports both witnesses separately', () => {
    const { host } = phone();

    const sheet = document.querySelector('[data-testid="launch-sheet"]');
    const mobileSheet = document.querySelector('[data-testid="mobile-sheet"]');

    /* TWO QUESTIONS, TWO ANSWERS. `launch-sheet` says the sheet mounted;
       `mobile-sheet` says it went through the phone host. Before this change
       the first was true and the second had no code path that could make it
       true — the file contained no reference to MobileSheet at all. */
    expect(sheet).not.toBeNull();
    expect(mobileSheet).not.toBeNull();

    /* And the portal actually landed in the FRAME's host, not merely somewhere
       in the document. Position belongs to the frame; this is that claim. */
    expect(host.contains(mobileSheet as Node)).toBe(true);
    expect(host.contains(sheet as Node)).toBe(true);

    /* The arrangement stamp, so a capture can tell which of the two shapes it
       photographed rather than inferring it from a width. */
    expect((sheet as HTMLElement).dataset.arrangement).toBe('phone');
  });

  it('does not stack a second dialog inside the frame’s', () => {
    const { host } = phone();
    const sheet = host.querySelector('[data-testid="launch-sheet"]') as HTMLElement;

    /* `MobileSheet`'s panel already declares role=dialog + aria-modal. This root
       drops both on the phone: one surface, one dialog, which is what a screen
       reader is entitled to.

       SCOPED TO THIS HOST, not to the document. A document-wide count would be
       measuring every other case's leftovers as much as this one's, and would
       pass or fail on test ORDER — the kind of assertion that is green until
       somebody adds a case above it. */
    expect(sheet.getAttribute('role')).toBeNull();
    expect(sheet.getAttribute('aria-modal')).toBeNull();
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it('drops the header that names a panel stack and a key this shell does not have', () => {
    const { host } = phone();
    /* "sheet on the stack · esc closes" is not merely redundant beside the
       frame's own title and ✕ — it is FALSE here. The phone has no panel stack
       and no Escape key. The shell's honesty rules do not stop at refusal
       cards. */
    expect(host.textContent).not.toContain('sheet on the stack');
    /* The control on it: the string EXISTS in the component, so this assertion
       could not pass merely because the copy was renamed. The desktop case at
       the bottom of this file asserts it is still there. */
    expect(host.textContent).toContain('Launch session');
  });

  /**
   * THE GUARD, ON THE ROUTE THAT ONLY EXISTS HERE.
   *
   * A sheet brings a backdrop and an Escape with it. The desktop sheet's
   * in-flight protection lives on `disabled` attributes, which those two routes
   * never touch — so without an explicit guard the phone would be the one shell
   * where a tap outside drops the surface while a spawn is outstanding, leaving
   * a session starting with nothing on screen saying so.
   */
  it('refuses every dismissal route while a spawn is outstanding', () => {
    const onCancel = vi.fn();
    phone({ launching: true, onCancel });

    const scrim = document.querySelector('[data-testid="mobile-sheet"]') as HTMLElement;
    fireEvent.click(scrim);
    expect(onCancel).not.toHaveBeenCalled();

    const close = document.querySelector('.msheet__close') as HTMLElement;
    fireEvent.click(close);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('dismisses on the backdrop when nothing is in flight', () => {
    const onCancel = vi.fn();
    phone({ onCancel });

    const scrim = document.querySelector('[data-testid="mobile-sheet"]') as HTMLElement;
    fireEvent.click(scrim);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  /**
   * THE CONTROL ON THE CONTROL. Everything above would also pass on a component
   * that had been switched to the phone arrangement unconditionally, which
   * would be a far worse defect than the one it fixes — the desktop shell is in
   * daily use. With no provider there is no host, and the desktop keeps the
   * overlay it has always had.
   */
  it('leaves the desktop overlay alone — its own dialog, its own header', () => {
    render(
      <div className="cv2-root">
        <LaunchSheet
          subjectId={'task-1' as EntityId}
          fromChip="◔ Run ▸"
          fromCaption="task pre-associated"
          teammates={LAUNCH_TEAMMATES}
          projects={LAUNCH_PROJECTS}
          profiles={LAUNCH_PROFILES}
          capacity={LAUNCH_CAPACITY}
          onLaunch={() => {}}
          onCancel={() => {}}
        />
      </div>,
    );

    const sheet = document.querySelector('.cv2-root [data-testid="launch-sheet"]') as HTMLElement;
    expect(sheet.dataset.arrangement).toBe('overlay');
    expect(sheet.getAttribute('role')).toBe('dialog');
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(sheet.querySelector('.ls__head')).not.toBeNull();
    expect(sheet.textContent).toContain('sheet on the stack');
  });
});
