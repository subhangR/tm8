import { createRoot } from 'react-dom/client';
import type { EntityId, SessionTranscriptPage } from '@tm8/contract';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
import { ptyTransport } from './terminal/pty/ptyTransport';
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
 * be seen.
 *
 * LIVENESS IS A QUERY PARAMETER, because the two things this harness has to
 * show are mutually exclusive under one hardcoded value. The scroll rules want
 * `not-running`, so no poll competes with the measurement; the COMPOSER only
 * renders when the session is live, and the composer is the other half of what
 * cannot be seen in jsdom (a card has no border there, and no upload can round
 * trip). Default stays `not-running` so every measurement taken against this
 * file before today still reproduces.
 *
 * Usage:
 *   /transcript-dev.html                  — the scroll rules (no poll)
 *   /transcript-dev.html?liveness=live    — the composer, attach, paste, drop
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

const params = new URLSearchParams(location.search);
const liveness = params.get('liveness') === 'live' ? 'live' : 'not-running';

/**
 * THE UPLOAD, STUBBED AT THE TRANSPORT and nowhere higher up.
 *
 * `uploadClipboardFile` is left completely intact and really runs: it reads the
 * node from `ptyTransport.endpointFor`, builds the headers, and POSTs the raw
 * bytes. What is faked is the two things a harness cannot have — a node to be
 * bound to, and a server at the other end. Stubbing any higher (an injected
 * uploader prop, say) would leave the header assembly, the endpoint lookup and
 * the error path untested by the only thing that can run them.
 *
 * `endpointFor` is a method on a plain object, so overriding it here is a
 * dev-harness edit and not a seam in the product.
 */
if (liveness === 'live') {
  ptyTransport.endpointFor = (id: string) =>
    id === SESSION ? { baseUrl: 'http://transcript-dev.invalid', authToken: 'dev' } : null;

  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('http://transcript-dev.invalid')) return realFetch(input, init);
    const name = (init?.headers as Record<string, string> | undefined)?.['x-tm8-filename']
      ?? 'pasted-file';
    /* FAIL ON DEMAND, so the failure path is reachable by hand: any file whose
       name contains `fail` comes back the way the node's own refusals do. */
    if (/fail/i.test(name)) {
      return Promise.resolve(new Response(
        JSON.stringify({ error: { message: 'the node refused these bytes' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ));
    }
    /* Latency, because an instant insert hides the busy chip and the Send gate
       that hangs off it. */
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(Response.json({
          path: `/Users/agent/.tm8/clipboard/${SESSION}/${name}`,
          filename: name,
          mimeType: 'application/octet-stream',
          bytes: 4096,
        }));
      }, 900);
    });
  }) as typeof fetch;
}

document.body.className = 'cv2-root';
document.body.setAttribute('data-theme', 'dark');
document.body.style.margin = '0';

createRoot(document.getElementById('root')!).render(
  <div className="cv2-root" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    {/* The panel body's box: a bounded height with a min-height:0 child, which
        is what turns `.tr-surface__scroll` into an actual scroll container. */}
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <TranscriptSurface seam={seam} sessionId={SESSION} liveness={liveness} />
    </div>
  </div>,
);
