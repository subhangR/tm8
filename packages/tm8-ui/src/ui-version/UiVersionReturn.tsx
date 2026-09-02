/**
 * THE WAY BACK from the frozen 1.0 UI to the product UI.
 *
 * This package is the pre-Astryx snapshot (`672df036`, 2026-08-29). Since the
 * UI version switch it is built with `base: '/ui-1.0/'` and served beside
 * `packages/tm8_ui_2.0` on one origin, so a viewer who switched needs a door
 * home that does not require them to know the URL. A one-way switch is a trap,
 * and "just edit the address bar" is not a control.
 *
 * WHY IT IS UNCONDITIONAL, unlike the forward control in 2.0. That one probes,
 * because the 1.0 bundle is optional and may not be served. This one needs no
 * probe: `/` is where the product UI always is, and if this bundle is on
 * screen at all then it was served from the same origin — so the destination
 * is reachable by construction. A probe here would be ceremony that can only
 * ever say yes.
 *
 * IT IS ALSO ALWAYS VISIBLE, not folded into a menu. In 2.0 the switch sits in
 * the account menu because that bar's right side was deliberately emptied
 * (revision 21) and the menu is where per-viewer utilities went. Here the
 * balance is different: this is the ALTERNATE UI, a place a viewer arrives at
 * deliberately and needs to leave reliably, possibly after finding that
 * something they wanted is missing from it. The exit belongs in the chrome.
 */
import './ui-version.css';

/** The product UI's address. See `tm8_ui_2.0/src/ui-version/mount.ts`. */
const UI_2_0_PATH = '/';

const LABEL = 'Back to UI 2.0';

export function UiVersionReturn({ className }: { className?: string }) {
  return (
    <a
      className={`ui-version${className ? ` ${className}` : ''}`}
      href={UI_2_0_PATH}
      data-testid="back-to-ui-2-0"
      aria-label={LABEL}
      title="The current product UI"
    >
      {/* Decorative: the label beside it is the accessible name. */}
      <span className="ui-version__glyph" aria-hidden>
        ⇄
      </span>{' '}
      {LABEL}
    </a>
  );
}
