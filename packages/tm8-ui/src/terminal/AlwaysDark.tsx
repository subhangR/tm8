import type { ReactNode } from 'react';
import { useAlwaysDarkTheme } from '../theme/useAlwaysDarkTheme';

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
 * `data-always-dark="true"` IS NOW THE SWITCH (style design §3.3). The injected
 * `<style id="tm8-style-active">` (theme/style-store.ts) declares the active
 * style on the `.cv2-root`s whose theme agrees with it, which in dark includes
 * this scope; its second rule re-declares the resolved always-dark ramp for
 * `[data-always-dark="true"]` and wins by source order. `data-theme` is
 * DERIVED by `useAlwaysDarkTheme`: `"dark"` while `--pn-term-chrome` is
 * `dark` (every built-in — the attribute today's component rules,
 * `kit/Mermaid.tsx` and tokens.css's no-JS fallback key on), and the active
 * style's own theme when it is `follow`, so a light style gets a light
 * terminal area. Every always-dark scope
 * (WorkspaceGrid, Z4Host, FilesScreen, NodeRoom, TypedTerminal, the
 * always-dark EntityDetailPanel) stamps itself through the same hook.
 *
 * `display: contents` makes this a pure scope with no box of its own, so the
 * wrapped children keep participating in the PARENT's layout (a strip inside
 * a flex column still lays out as that column's child). Custom properties
 * inherit through `display: contents` unaffected, which is exactly the
 * property being exploited. Style the children, never this element.
 */
export function AlwaysDark({ children }: { children: ReactNode }) {
  const alwaysDarkTheme = useAlwaysDarkTheme();
  return (
    <div
      className="cv2-root"
      data-theme={alwaysDarkTheme}
      data-always-dark="true"
      style={{ display: 'contents' }}
    >
      {children}
    </div>
  );
}
