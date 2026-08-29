import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
/* BOTH SHEETS, AND NEITHER IS OPTIONAL. The FAB's measurements are spread over
   two scopes that a real phone screen always has and a bare harness does not:
   `--mobile-touch-min` (the 44px floor every chip stands on) is declared on
   `.mobile-frame` in `mobile.css`, and `--mobile-fab-size` (the trigger's 56px,
   which the menu's own bottom inset is expressed against) on
   `.cv2-root[data-shell='mobile']` in `mobile-screens.css`.

   MEASURED, NOT ASSUMED: without them the chips render 22px tall and the stack
   sits over the trigger. The harness therefore wears BOTH — the class and the
   attribute — because a harness missing a token reports a defect the product
   does not have, which is worse than no harness. */
import './mobile/mobile.css';
import './mobile/mobile-screens.css';

import { EntityFab, MobileSurfaceProvider, type EntityFabItem } from './mobile';

/**
 * ENTITY-FAB SCRATCH HARNESS — same spirit as `chat-dev.tsx` and
 * `terminal-dev.tsx`: a gate-free mount of ONE control, so a browser can answer
 * what jsdom structurally cannot.
 *
 * The FAB's whole subject is appearance. jsdom loads no stylesheets, so nothing
 * in `entity-fab.test.tsx` can see whether a chip reads over the scrim, whether
 * the counts line up, whether a refused row is legibly dim rather than a smudge,
 * or whether the stack fits above the trigger — which is every question the
 * owner's ruling of 2026-08-20 was actually about.
 *
 * WHY IT DOES NOT MOUNT `EntityView`. The FAB's real host needs a signed-in
 * node, a space, a kind registry, live counts and a detail fetch, and reaching
 * it means going through the auth wall on a running server. `EntityFab` takes
 * a plain array; `panelMenuItems` is what fills that array, and its output is
 * already pinned by `panel-phone-chrome.test.tsx`. So the harness feeds the
 * shape that function produces and the two halves stay separately checkable.
 *
 * `data-shell='mobile'` on `.cv2-root` is what every rule in `entity-fab.css`
 * keys off, and `MobileSurfaceProvider` is what makes the component render at
 * all — the two facts a phone screen would supply.
 *
 * Usage: /fab-dev.html   (?theme=dark for the dark ground,
 *                         ?state=refused for a menu that is all refusals,
 *                         ?state=mixed  for refused rows above live ones,
 *                         ?long=1       for a label that must ellipsise)
 */

/** What `panelMenuItems` returns for a task on a host with a wired dispatcher:
    the two aux tabs with their counts, then the kind's primaries. */
const LIVE: EntityFabItem[] = [
  { id: 'connections', label: 'Connections', count: 52 },
  { id: 'discussion', label: 'Discussion', count: 0 },
  { id: 'run', label: 'Run', glyph: '▶' },
  { id: 'edit', label: 'Edit', glyph: '✎' },
];

/** The refusals this menu actually produces — an unwired dispatcher, and the
    merge confirm that has no phone arrangement. Both sentences are verbatim
    from `chrome.tsx`, because their LENGTH is the thing being looked at. */
const REFUSED: EntityFabItem[] = [
  {
    id: 'merge-pr',
    label: 'Merge',
    glyph: '⑃',
    reason:
      'This verb stops at a confirmation card that has no phone arrangement — open this entity on a desktop to reach it',
  },
  {
    id: 'terminate',
    label: 'Terminate',
    glyph: '⏻',
    reason: 'This action isn’t connected yet — the verb exists and its screen does not dispatch it in this build',
  },
];

function itemsFor(state: string | null, long: boolean): EntityFabItem[] {
  const live = long
    ? [{ ...LIVE[0]!, label: 'Connections and everything else this entity touches' }, ...LIVE.slice(1)]
    : LIVE;
  if (state === 'refused') return REFUSED;
  if (state === 'mixed') return [live[0]!, REFUSED[0]!, live[2]!, REFUSED[1]!, live[3]!];
  return live;
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : undefined;
  const items = itemsFor(params.get('state'), params.get('long') === '1');

  return (
    <div
      className="cv2-root"
      data-theme={theme}
      data-shell="mobile"
      /* A FIXED 390x844 BOX, not `100vh` — this shell's whole subject is a
         phone, and a harness that inherits the desktop window's width reports
         a chip stack with room it will never have. The screenshots on the PR
         are only worth something if the frame they were taken in is the frame
         the rules were written for. */
      style={{
        background: 'var(--pn-paper)',
        inlineSize: 390,
        blockSize: 844,
        margin: '0 auto',
        border: '1px solid var(--pn-line-2)',
      }}
    >
      {/* THE POSITIONED, NON-SCROLLING ROOT the component's docblock requires —
          `EntityFab`'s layer is `position: absolute; inset: 0`, so without a
          positioned ancestor here it would resolve against the initial
          containing block and the harness would be measuring a different
          arrangement from the one `EntityView` mounts. */}
      <div
        className="mobile-frame"
        style={{ position: 'relative', height: '100%', overflow: 'hidden' }}
      >
        {/* Page text behind the menu, because the scrim is half of what makes a
            chip legible or not: a white pill over white paper and the same pill
            over a 32%-dimmed page are different readings, and the second is the
            only one that ever ships. */}
        <div style={{ padding: 'var(--pn-space-4)', color: 'var(--pn-ink-2)' }}>
          <h2 className="t-h2">Acceptance gate — real device pass</h2>
          {Array.from({ length: 14 }, (_, i) => (
            <p key={i} className="t-body">
              Repo: github.com/subhangR/tm8, latest main. Product package is packages/tm8-ui.
              This is coarse-pointer phone only — the shell fork is pointer AND width under 500px.
            </p>
          ))}
        </div>

        <MobileSurfaceProvider sheetHost={document.body}>
          <EntityFab items={items} label="Task actions" />
        </MobileSurfaceProvider>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
