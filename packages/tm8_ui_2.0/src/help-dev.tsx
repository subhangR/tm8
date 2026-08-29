import { useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './shell/shell.css';
/* THE PHONE'S ZOOM GATE. `app.css` puts `zoom: 1.1` on `.cv2-root` and
   `mobile-chrome.css` declines it for `[data-shell='mobile']` — a harness that
   sets the attribute without loading that file renders the phone at 1.1 and
   every rect it reports is 10% too large. */
import './mobile/mobile-chrome.css';
import type { SpaceId } from '@tm8/contract';
import { HelpScreen } from './help';
import { HELP_PLATES } from './help/help-plates';
import { resetNav } from './stores/navStore';

/**
 * HELP LIBRARY SCRATCH HARNESS — the same instrument as `reader-dev.tsx` and
 * `chat-dev.tsx`: a gate-free mount of ONE screen, so a real browser can answer
 * what jsdom structurally cannot.
 *
 * WHY THIS LANE CANNOT SKIP IT. Help's whole payload is 55 documents rendered
 * inside a sandboxed frame, and jsdom loads no stylesheets AND never loads a
 * frame's document — so `help.test.tsx` can prove which plate is addressed and
 * has no opinion whatsoever about the four things the port is actually made of:
 *
 *   1. does the plate DRAW — the frame is opaque-origin and self-contained, so
 *      "the asset URL resolved" and "the document rendered" are different
 *      claims and only a browser can make the second one;
 *   2. does the app's dark theme reach INSIDE the frame? The mechanism is
 *      inherited `color-scheme` on `.cv2-root[data-theme="dark"]`, which no
 *      test environment implements;
 *   3. does the plate fill the reader and scroll internally, rather than
 *      growing the pane or clipping;
 *   4. does the phone arrangement — one column, contents then plate — leave the
 *      frame a usable width at 390px.
 *
 * IT MOUNTS PRODUCTION CODE AND A REAL ROUTE. `resetNav` seeds the same store
 * the router writes, so `?plate=` here is the deep link, not a prop.
 *
 * Usage: /help-dev.html   (?theme=dark for the dark ground,
 *                          ?shell=mobile for the phone arrangement,
 *                          ?plate=<slug|number> to open one plate)
 */

function slugFor(raw: string | null): string | null {
  if (!raw) return null;
  const byNumber = Number.parseInt(raw, 10);
  if (Number.isFinite(byNumber)) {
    return HELP_PLATES.find((plate) => plate.number === byNumber)?.slug ?? null;
  }
  return raw;
}

function HelpHarness() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : undefined;
  const mobile = params.get('shell') === 'mobile';
  const [ready, setReady] = useState(false);

  useEffect(() => {
    resetNav('harness-space' as SpaceId, { view: 'help', plate: slugFor(params.get('plate')) });
    const timer = window.setTimeout(() => setReady(true), 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="cv2-root"
      data-theme={theme}
      data-shell={mobile ? 'mobile' : undefined}
      data-harness-ready={ready || undefined}
      /* A FLEX COLUMN with a real height: `.hlp-root` is `flex: 1; height:
         100%`, so a plain block host would size it to its CONTENT and the
         reader would have no scroller to be judged. The phone's touch tokens
         are published here because they are declared on `.mobile-frame`, which
         a one-surface harness does not mount — without them every
         `min-block-size: var(--mobile-touch-min)` rule is silently dropped. */
      style={{
        display: 'flex',
        height: '100vh',
        background: 'var(--pn-paper)',
        ...(mobile
          ? ({
              '--mobile-touch-min': '44px',
              '--mobile-keyboard-inset': '0px',
              '--mobile-safe-bottom': '0px',
            } as CSSProperties)
          : {}),
      }}
    >
      <HelpScreen stacked={mobile} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<HelpHarness />);
