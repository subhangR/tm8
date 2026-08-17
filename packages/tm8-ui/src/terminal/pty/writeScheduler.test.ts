// @vitest-environment jsdom
/**
 * Write-scheduler tests, ported from maestro's terminalWriteScheduler suite.
 *
 * The load-bearing one is the LAST: flushing a session whose terminal is NOT
 * mounted must still DRAIN the buffer (into the pending sink) and leave no
 * residual. The visibility driver flushes immediately before suspending, and the
 * transport's resume offset counts bytes as they ARRIVE — so if a flush could
 * leave bytes behind, resume would reopen at an offset PAST bytes the terminal
 * never received. That is a silent hole with no gap marker, because the server's
 * accounting stays perfectly correct and the loss is entirely client-side.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetTerminalWriteScheduler,
  dropTerminalOutput,
  flushTerminalOutput,
  initTerminalWriteScheduler,
  queueTerminalOutput,
} from './writeScheduler.js';

interface FakeTerm {
  writes: string[];
  write(d: string): void;
  element?: HTMLElement;
}

function makeTerm(visible = true): FakeTerm {
  const el = document.createElement('div');
  el.style.visibility = visible ? 'visible' : 'hidden';
  document.body.appendChild(el);
  const term: FakeTerm = {
    writes: [],
    write(d: string) {
      this.writes.push(d);
    },
    element: el,
  };
  return term;
}

describe('terminal write scheduler', () => {
  let terms: Map<string, FakeTerm>;
  let pending: Array<{ id: string; data: string }>;

  beforeEach(() => {
    terms = new Map();
    pending = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
    );
    vi.stubGlobal('cancelAnimationFrame', (h: number) => clearTimeout(h));
    initTerminalWriteScheduler({
      getTerm: (id) => terms.get(id),
      bufferPending: (id, data) => pending.push({ id, data }),
    });
  });

  afterEach(() => {
    __resetTerminalWriteScheduler();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('coalesces several chunks into ONE write per frame', async () => {
    const term = makeTerm();
    terms.set('s1', term);
    queueTerminalOutput('s1', 'a');
    queueTerminalOutput('s1', 'b');
    queueTerminalOutput('s1', 'c');
    // Nothing written yet — the whole point is to batch, not write per chunk.
    expect(term.writes).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    expect(term.writes).toEqual(['abc']);
  });

  it('flushTerminalOutput writes SYNCHRONOUSLY (the pre-suspend contract)', () => {
    const term = makeTerm();
    terms.set('s1', term);
    queueTerminalOutput('s1', 'hello');
    expect(term.writes).toEqual([]);
    flushTerminalOutput('s1');
    // Synchronous: no timer, no frame. The visibility driver depends on this —
    // it flushes and suspends with no await in between.
    expect(term.writes).toEqual(['hello']);
  });

  it('force-flushes past the hidden throttle so a hidden terminal still drains', () => {
    const term = makeTerm(false);
    terms.set('s1', term);
    queueTerminalOutput('s1', 'x');
    flushTerminalOutput('s1');
    expect(term.writes).toEqual(['x']);
  });

  it('throttles a terminal below display:none as hidden, not visible', async () => {
    const term = makeTerm(true);
    const surface = document.createElement('div');
    surface.style.display = 'none';
    term.element!.parentElement?.removeChild(term.element!);
    surface.appendChild(term.element!);
    document.body.appendChild(surface);
    terms.set('s1', term);

    queueTerminalOutput('s1', 'first');
    await new Promise((r) => setTimeout(r, 5));
    expect(term.writes).toEqual(['first']);

    queueTerminalOutput('s1', 'held');
    await new Promise((r) => setTimeout(r, 5));
    expect(term.writes).toEqual(['first']);

    surface.style.display = 'block';
    await new Promise((r) => setTimeout(r, 5));
    expect(term.writes).toEqual(['first', 'held']);
  });

  it('dropTerminalOutput discards buffered chunks (stale pre-reset output)', async () => {
    const term = makeTerm();
    terms.set('s1', term);
    queueTerminalOutput('s1', 'stale');
    dropTerminalOutput('s1');
    await new Promise((r) => setTimeout(r, 5));
    expect(term.writes).toEqual([]);
  });

  it('flushTerminalOutput drains to pending (never leaves a residual buffer) when the terminal is unmounted', () => {
    // No terminal registered for this id.
    queueTerminalOutput('ghost', 'one');
    queueTerminalOutput('ghost', 'two');
    flushTerminalOutput('ghost');

    // Drained into the pending sink...
    expect(pending.map((p) => p.data)).toEqual(['one', 'two']);

    // ...and NOTHING is left buffered. If a residual survived here, a suspend
    // right after would preserve a resume offset ahead of delivered bytes.
    const term = makeTerm();
    terms.set('ghost', term);
    flushTerminalOutput('ghost');
    expect(term.writes).toEqual([]);
  });
});
