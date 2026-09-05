/**
 * THE WAY BACK from the alternate 2.0 UI to the product UI.
 *
 * This package was the product UI at `/` from 2026-08-29 (PRs #526/#531) until
 * 2026-09-03, when the owner reversed that. It is now built with
 * `base: '/ui-2.0/'` and served beside `packages/tm8-ui` on one origin, so a
 * viewer who switched needs a door home that does not require them to know the
 * URL. A one-way switch is a trap, and "just edit the address bar" is not a
 * control.
 *
 * WHY IT IS UNCONDITIONAL, and why it needs no probe: `/` is where the product
 * UI always is, and if this bundle is on screen at all then it was served from
 * the same origin — so the destination is reachable by construction. A probe
 * here would be ceremony that can only ever say yes.
 *
 * THE FORWARD CONTROL IS GONE as of 2026-09-05. `packages/tm8-ui`'s tab bar
 * carried a "Switch to UI 2.0" link; on every server that sets no
 * `TM8_UI_2_0_DIR` — which is all of them — it drew itself disabled with an
 * operator's env var quoted at the viewer, and the owner asked for it out.
 * THIS control stays, and matters more for it: `/ui-2.0/` is now reached by
 * typing the address, and stranding whoever does that in a bundle with no way
 * home is the trap this file exists to prevent.
 *
 * IT STAYS IN THE ACCOUNT MENU, where the forward switch used to hang. The
 * reasoning that put it there (revision 21 deliberately emptied the bar's right
 * side; the tabs are data-driven from MenuConfig groups and a UI version is not
 * a group) is about this bundle's chrome and did not change when its role did.
 */
import './ui-version.css';

/** The product UI's address — the root, where `packages/tm8-ui` is served. */
const UI_1_0_PATH = '/';

const LABEL = 'Back to UI 1.0';

export interface UiVersionReturnProps {
  /**
   * Row grammar from the host. Passed in rather than applied here for the same
   * reason `CopyLinkControl` takes it: the host chose to hang this in a menu,
   * so the host says how it sits there.
   */
  className?: string;
}

export function UiVersionReturn({ className }: UiVersionReturnProps) {
  return (
    <a
      className={`ui-version${className ? ` ${className}` : ''}`}
      href={UI_1_0_PATH}
      data-testid="back-to-ui-1-0"
      aria-label={LABEL}
      title="The current product UI"
      /* Not `target="_blank"`: this replaces the app rather than opening a
         second copy of it beside itself. Two live UIs over one catalog would
         put the same entity on screen twice with independent event streams. */
    >
      {/* Decorative: the label beside it is the accessible name. */}
      <span className="ui-version__glyph" aria-hidden>
        ⇄
      </span>{' '}
      {LABEL}
    </a>
  );
}
