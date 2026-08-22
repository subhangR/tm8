import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import './kit/kit.css';
import './chat-home/chat-home.css';
import { CrewCard, LiveDock, CREW_FIXTURES } from './chat-home/crew';

/**
 * THE CREW SCRATCH HARNESS — the Crew Card and the Live Dock, every fixture,
 * on both grounds, in a real browser.
 *
 * Same spirit as chat-dev.tsx and loader-dev.tsx, and needed for the same
 * reason: jsdom loads no stylesheets and rasterizes nothing, so a green suite
 * is not evidence that either surface READS. Four questions only a browser
 * answers for these two components:
 *
 *   1. does a status pill stay legible at the card's row density, and does
 *      the "needs you" tint read as noticeable-but-not-shouting?
 *   2. does the indeterminate track look like motion or like a glitch?
 *   3. does the dock stay one slim line at every state, including the
 *      collapsed "All done" one?
 *   4. do both survive the dark ground, where the tint tokens invert?
 *
 * `chat-home.css` is imported alongside `crew.css` (which the components pull
 * in themselves) because the dock and card sit inside chat chrome in the real
 * app and inherit its type scale.
 *
 * Usage: /crew-dev.html   (add ?theme=dark for the dark ground)
 *
 * IT PASSES REAL HANDLERS. The components read an ABSENT callback as "this
 * host cannot do that" and disable the control with a reason — see
 * `no-op-handler-ban.test.ts`. A harness whose whole job is to show the
 * enabled appearance has to hand over something that works, so these log.
 */
if (new URLSearchParams(location.search).get('theme') === 'dark') {
  document.documentElement.setAttribute('data-theme', 'dark');
}

function CrewDev() {
  const [log, setLog] = useState<string[]>([]);
  const note = (line: string) => setLog((lines) => [line, ...lines].slice(0, 6));

  return (
    <div className="cv2-root" style={{ padding: 24, display: 'grid', gap: 32, maxWidth: 620 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 20 }}>Crew Card + Live Dock</h1>
        <p style={{ margin: '6px 0 0', opacity: 0.7, fontSize: 13 }}>
          Prototype sections A and C, driven entirely by fixtures. Nothing here reads a real
          session — that signal is DESIGN 2&apos;s.
        </p>
      </div>

      {CREW_FIXTURES.map((fixture) => (
        <section key={fixture.name} style={{ display: 'grid', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 13, opacity: 0.6, textTransform: 'uppercase' }}>
            {fixture.name}
          </h2>
          <CrewCard
            crew={fixture.crew}
            onRespond={() => note(`answer · ${fixture.name}`)}
            onHelperAction={(helper) => note(`action · ${helper.role}`)}
          />
          {/* The dock sits directly above the composer in the real screen; the
              faux composer below is here so its proportions can be judged
              against the thing it actually neighbours. */}
          <LiveDock crew={fixture.crew} onOpenCrew={() => note(`open card · ${fixture.name}`)} />
          <div
            style={{
              border: '1px solid var(--pn-line)',
              borderRadius: 12,
              padding: '10px 12px',
              fontSize: 13,
              opacity: 0.5,
            }}
          >
            Reply…
          </div>
        </section>
      ))}

      <pre style={{ fontSize: 11, opacity: 0.6, margin: 0 }}>{log.join('\n')}</pre>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<CrewDev />);
