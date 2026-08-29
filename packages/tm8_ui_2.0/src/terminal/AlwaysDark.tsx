import type { ReactNode } from 'react';

/**
 * ALWAYS-DARK scope.
 *
 * The xterm canvas is near-black in BOTH themes — that contrast is
 * established, not a preference — so the chrome that touches it (the strip,
 * the live-session bar, the roster) is dark graphite in both themes too.
 * T0-2 states it plainly: one rendering gets pixel-frozen, not a light twin
 * and a dark twin.
 *
 * MECHANISM, and why this is not a pile of hex literals: tokens.css scopes
 * the dark ramp to `.cv2-root[data-theme="dark"], [data-theme="dark"]
 * .cv2-root`. Opening a nested element carrying BOTH the class and the
 * attribute re-declares every real dark token inside this subtree, through
 * the token file's own selector. The always-dark regions are therefore styled
 * with ordinary `var(--pn-…)` and can never drift from tokens.css — whereas
 * restating the dark ramp as literals in a component stylesheet would rot
 * silently the first time a token moved.
 *
 * `display: contents` makes this a pure scope with no box of its own, so the
 * wrapped children keep participating in the PARENT's layout (a strip inside
 * a flex column still lays out as that column's child). Custom properties
 * inherit through `display: contents` unaffected, which is exactly the
 * property being exploited. Style the children, never this element.
 */
export function AlwaysDark({ children }: { children: ReactNode }) {
  return (
    <div
      className="cv2-root"
      data-theme="dark"
      data-always-dark="true"
      style={{ display: 'contents' }}
    >
      {children}
    </div>
  );
}
