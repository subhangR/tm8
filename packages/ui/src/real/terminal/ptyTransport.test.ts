/**
 * Offset-resume and stream-identity tests for the PTY transport.
 *
 * These pin the accounting the whole design rests on, against a fake WebSocket:
 *  - the client SNAPS to `attached.next` and never to `base + replay.length`
 *    (the replay slice is sanitized and therefore SHORTER than the raw span);
 *  - the replay frame is DISPLAY-ONLY and is not counted;
 *  - live frames advance the offset by their RAW byte length;
 *  - a reset happens on a changed epoch, or a gap, or a legacy base rewind —
 *    and NOT on an ordinary resume;
 *  - a suspended socket does not auto-reconnect and keeps its offset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ptyTransport } from './ptyTransport.js';

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CLOSING = 2;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = 1;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: unknown[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  /** Deliver a server text control frame. */
  text(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  /** Deliver a server binary frame. */
  bin(s: string) {
    const bytes = new TextEncoder().encode(s);
    this.onmessage?.({ data: bytes.buffer });
  }
}

const last = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
const offsetOf = (ws: FakeWebSocket) => Number(new URL(ws.url).searchParams.get('offset'));

describe('pty transport — offset resume', () => {
  let out: Array<{ id: string; data: string }>;
  let reattached: string[];
  let offOut: () => void;
  let offRe: () => void;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:4611' });
    out = [];
    reattached = [];
    offOut = ptyTransport.onOutput((id, data) => out.push({ id, data }));
    offRe = ptyTransport.onReattach((id) => reattached.push(id));
  });

  afterEach(() => {
    offOut();
    offRe();
    ptyTransport.closeSession('s1');
    vi.unstubAllGlobals();
  });

  it('connects at offset 0 and snaps to attached.next, NOT base + replay length', () => {
    ptyTransport.openSession('s1');
    expect(offsetOf(last())).toBe(0);

    // The replay slice is SHORTER than the raw span it represents (sanitized):
    // 5 chars of payload standing for 432 raw bytes.
    last().text({ type: 'attached', base: 0, gap: 0, next: 432, hasReplay: true, epoch: 'e1' });
    last().bin('hello');

    // Snapped to `next`, and the display-only replay frame was NOT counted.
    expect(ptyTransport.__received('s1')).toBe(432);
    expect(reattached).toEqual([]); // a first attach is not a reset
  });

  it('advances the offset by the RAW byte length of live frames', () => {
    ptyTransport.openSession('s1');
    last().text({ type: 'attached', base: 0, gap: 0, next: 100, hasReplay: false, epoch: 'e1' });
    last().bin('abc'); // 3 bytes
    last().bin('é'); // 2 bytes in UTF-8, not 1
    expect(ptyTransport.__received('s1')).toBe(105);
  });

  it('resumes at the preserved offset after a transport drop, with NO reset', () => {
    ptyTransport.openSession('s1');
    last().text({ type: 'attached', base: 0, gap: 0, next: 50, hasReplay: false, epoch: 'e1' });
    last().bin('12345');
    expect(ptyTransport.__received('s1')).toBe(55);

    const before = FakeWebSocket.instances.length;
    last().close();
    // The auto-reconnect is scheduled with exponential backoff; rather than
    // waiting on a timer, drive the same reopen path suspend/resume uses and
    // assert it carried the PRESERVED offset.
    ptyTransport.suspend('s1');
    ptyTransport.resume('s1');
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before);
    expect(offsetOf(last())).toBe(55);

    last().text({ type: 'attached', base: 55, gap: 0, next: 55, hasReplay: false, epoch: 'e1' });
    // Same epoch, no gap, no rewind → an ordinary resume, so NO reset fired.
    expect(reattached).toEqual([]);
  });

  it('RESETS when the epoch changes (a respawn), even without a byte rewind', () => {
    ptyTransport.openSession('s1');
    last().text({ type: 'attached', base: 0, gap: 0, next: 10, hasReplay: false, epoch: 'e1' });
    expect(reattached).toEqual([]);
    // A fresh stream can emit at least as many bytes, so `base` need not rewind —
    // the epoch is the only honest signal.
    last().text({ type: 'attached', base: 20, gap: 0, next: 30, hasReplay: false, epoch: 'e2' });
    expect(reattached).toEqual(['s1']);
    expect(ptyTransport.__received('s1')).toBe(30);
  });

  it('RESETS on a gap (ring eviction), epoch unchanged', () => {
    ptyTransport.openSession('s1');
    last().text({ type: 'attached', base: 0, gap: 0, next: 10, hasReplay: false, epoch: 'e1' });
    last().text({ type: 'attached', base: 500, gap: 490, next: 900, hasReplay: true, replayKind: 'snapshot', epoch: 'e1' });
    expect(reattached).toEqual(['s1']);
    expect(ptyTransport.__received('s1')).toBe(900);
  });

  it('falls back to the legacy base-rewind heuristic only when NO epoch is present', () => {
    ptyTransport.openSession('s1');
    last().text({ type: 'attached', base: 0, gap: 0, next: 100, hasReplay: false });
    expect(reattached).toEqual([]);
    // base rewound below what we consumed, and there is no epoch to consult.
    last().text({ type: 'attached', base: 5, gap: 0, next: 20, hasReplay: false });
    expect(reattached).toEqual(['s1']);
  });

  it('suspend closes the socket, preserves the offset, and does NOT reconnect', () => {
    ptyTransport.openSession('s1');
    last().text({ type: 'attached', base: 0, gap: 0, next: 40, hasReplay: false, epoch: 'e1' });
    last().bin('xy');
    const count = FakeWebSocket.instances.length;

    ptyTransport.suspend('s1');
    expect(ptyTransport.__isSuspended('s1')).toBe(true);
    // No new socket was opened by the close handler.
    expect(FakeWebSocket.instances.length).toBe(count);
    // The resume offset survived.
    expect(ptyTransport.__received('s1')).toBe(42);

    ptyTransport.resume('s1');
    expect(ptyTransport.__isSuspended('s1')).toBe(false);
    expect(offsetOf(last())).toBe(42);
  });

  it('a snapshot replay is decoded standalone, not through the streaming decoder', () => {
    ptyTransport.openSession('s1');
    last().text({ type: 'attached', base: 0, gap: 5, next: 100, hasReplay: true, replayKind: 'snapshot', epoch: 'e1' });
    last().bin('SNAPSHOT');
    // Delivered (through the output channel, since no replay handler is
    // registered here) and NOT counted toward the offset.
    expect(out.some((o) => o.data === 'SNAPSHOT')).toBe(true);
    expect(ptyTransport.__received('s1')).toBe(100);
  });

  it('a resize measured BEFORE the socket opens is flushed on open, not dropped', () => {
    // The real sequence: the terminal mounts and fits itself immediately, which
    // races openSession()'s connect. Dropping that frame strands the PTY at
    // 80x24 forever — the local grid is already resized, so no later fit ever
    // re-sends it, and an agent TUI draws into a fraction of a wide terminal.
    ptyTransport.openSession('s1');
    const ws = last();
    ws.readyState = 0; // CONNECTING — not yet OPEN
    ptyTransport.resize('s1', 205, 51);
    expect(ws.sent).toEqual([]); // nothing sent while connecting

    ws.readyState = 1;
    ws.onopen?.();
    expect(ws.sent).toEqual([JSON.stringify({ type: 'resize', cols: 205, rows: 51 })]);
  });

  it('keeps only the LATEST pre-open size (superseded ones would just reflow twice)', () => {
    ptyTransport.openSession('s1');
    const ws = last();
    ws.readyState = 0;
    ptyTransport.resize('s1', 100, 20);
    ptyTransport.resize('s1', 205, 51);
    ws.readyState = 1;
    ws.onopen?.();
    expect(ws.sent).toEqual([JSON.stringify({ type: 'resize', cols: 205, rows: 51 })]);
  });

  it('sends keystrokes as BINARY frames (a text frame would be a control message)', () => {
    ptyTransport.openSession('s1');
    ptyTransport.write('s1', 'ls -la\r');
    // Filter by "not a string" rather than `instanceof Uint8Array`: under jsdom
    // the TextEncoder can come from a different realm, so instanceof lies.
    const sentBin = last().sent.filter((f) => typeof f !== 'string');
    expect(sentBin.length).toBe(1);
    expect(new TextDecoder().decode(sentBin[0] as Uint8Array)).toBe('ls -la\r');
  });

  it('a real exit frame ends the session and does not reconnect', () => {
    const exits: Array<number | null | undefined> = [];
    const offExit = ptyTransport.onExit((_id, code) => exits.push(code));
    ptyTransport.openSession('s1');
    last().text({ type: 'attached', base: 0, gap: 0, next: 0, hasReplay: false, epoch: 'e1' });
    const count = FakeWebSocket.instances.length;
    last().text({ type: 'exit', exitCode: 0 });
    expect(exits).toEqual([0]);
    // The close that follows the exit frame must not spawn a reconnect.
    last().close();
    expect(FakeWebSocket.instances.length).toBe(count);
    offExit();
  });
});
