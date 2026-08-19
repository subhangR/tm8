import { createRoot } from 'react-dom/client';
import type { EntityId, SessionTranscriptPage } from '@tm8/contract';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
import { TranscriptSurface } from './transcript/TranscriptSurface';

/**
 * TRANSCRIPT PAGE-BACK SCRATCH HARNESS — same family as `reader-dev.tsx` and
 * `settings-dev.tsx`: a gate-free mount for verifying ONE surface in a real
 * browser. Not product code, never imported by anything else.
 *
 * WHY IT IS NOT OPTIONAL FOR THIS CHANGE. The two rules this feature is mostly
 * made of are SCROLL rules, and jsdom has no layout: every element there reports
 * `scrollHeight: 0`. Mutating both rules out of `useTranscriptScroll` reds ZERO
 * tests in the package. So the anchoring and the bottom-pin are verified here,
 * against a browser that actually lays the list out, and nowhere else.
 *
 * THE PARENT IS REPRODUCED, NOT JUST THE COMPONENT. `.tr-surface` is
 * `height: 100%` and its scroll region is a `min-height: 0` flex child, so a
 * mount into a plain auto-height div has no scroll container at all and proves
 * nothing. The wrapper below is a fixed-height box under `.cv2-root`, which is
 * what the panel body gives it.
 *
 * The seam pages for real: five 12-turn windows keyed by byte cursor, the last
 * one landing on 0 so `hasOlder` goes false and the earned beginning claim can
 * be seen. `liveness: 'not-running'` so no poll competes with the measurement.
 *
 * Usage: /transcript-dev.html
 */

const SESSION = '01900000-0000-7000-8000-0000000000a1' as EntityId;

/** Cursor of each window, newest first. 0 is the start of the file. */
const CURSORS = [4000, 3000, 2000, 1000, 0];

const window0 = (index: number): SessionTranscriptPage => ({
  sessionId: SESSION,
  available: true,
  unavailableReason: null,
  searchedPaths: [],
  agentTool: 'claude-code',
  entries: Array.from({ length: 12 }, (_, i) => ({
    at: new Date(Date.UTC(2026, 7, 19, 9 + index, i * 4)).toISOString(),
    source: i % 4 === 0 ? ('user' as const) : ('assistant' as const),
    // The window number leads every line, so a screenshot says which windows
    // are on screen and a scroll measurement says which one the reader is at.
    text: `W${String(CURSORS.length - index)}·${String(i)} — ${
      i % 4 === 0
        ? 'a turn that arrived as input, so it sits on the right'
        : 'an agent turn, wide enough to take a couple of lines in this column so the list has real height to scroll through and the anchoring has something to hold onto'
    }`,
    truncated: false,
  })),
  stats: {
    partial: index > 0,
    userMessages: 3,
    assistantMessages: 9,
    toolCalls: 7,
    inputTokens: 4820,
    outputTokens: 640,
    cacheReadTokens: 18_200,
    cacheCreationTokens: 1100,
    tools: [{ name: 'Read', count: 4 }],
    models: ['claude-opus-4-6'],
  },
  stuck: null,
  lastActivityAt: new Date(Date.UTC(2026, 7, 19, 9 + index, 44)).toISOString(),
  malformed: 0,
  windowStart: CURSORS[index] ?? 0,
  hasOlder: (CURSORS[index] ?? 0) > 0,
});

const seam = {
  transcript: (_id: EntityId, opts?: { before?: number }): Promise<SessionTranscriptPage> => {
    const index = opts?.before === undefined ? 0 : CURSORS.indexOf(opts.before) + 1;
    const page = index >= 0 && index < CURSORS.length ? window0(index) : null;
    // Latency, because an instant prepend hides an anchoring bug that a real
    // one exposes: the correction has to survive a commit the reader can see.
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (page === null) reject(new Error(`no window for cursor ${String(opts?.before)}`));
        else resolve(page);
      }, 250);
    });
  },
  commands: { prompt: () => Promise.resolve({ ok: true }) },
} as never;

document.body.className = 'cv2-root';
document.body.setAttribute('data-theme', 'dark');
document.body.style.margin = '0';

createRoot(document.getElementById('root')!).render(
  <div className="cv2-root" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    {/* The panel body's box: a bounded height with a min-height:0 child, which
        is what turns `.tr-surface__scroll` into an actual scroll container. */}
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <TranscriptSurface seam={seam} sessionId={SESSION} liveness="not-running" />
    </div>
  </div>,
);
