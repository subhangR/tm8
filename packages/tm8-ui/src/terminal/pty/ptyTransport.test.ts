// @vitest-environment jsdom
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

import { PtyAttachRefused } from './ptyAttachRefusal.js';
import { ptyTransport } from './ptyTransport.js';

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CLOSING = 2;
  static instances: FakeWebSocket[] = [];

  url: string;
  protocols: string[];
  protocol: string;
  readyState = 1;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: unknown[] = [];

  constructor(url: string, protocols: string[] = []) {
    this.url = url;
    this.protocols = protocols;
    this.protocol = protocols[0] ?? '';
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
    ptyTransport.closeSession('s2');
    ptyTransport.closeSession('s3');
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

  it('commits attached.next only when the replay frame ARRIVES — a lost replay is re-requested', () => {
    ptyTransport.openSession('s1');
    last().text({ type: 'attached', base: 0, gap: 0, next: 700_000, hasReplay: true, epoch: 'e1' });
    // The socket dies before the replay frame lands (the server used to destroy
    // it on ordinary write backpressure right after queueing a big replay).
    expect(ptyTransport.__received('s1')).toBe(0);
    const before = FakeWebSocket.instances.length;
    last().close();
    ptyTransport.suspend('s1');
    ptyTransport.resume('s1');
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before);
    // The reconnect asks for the whole stream again, not for its end.
    expect(offsetOf(last())).toBe(0);
    last().text({ type: 'attached', base: 0, gap: 0, next: 700_000, hasReplay: true, epoch: 'e1' });
    last().bin('history');
    expect(ptyTransport.__received('s1')).toBe(700_000);
    expect(out.some((o) => o.data === 'history')).toBe(true);
  });

  it('routes a remote session through the selected server relay', () => {
    ptyTransport.openSession('s1', '/v2/server-connections/ec2/proxy');
    const url = new URL(last().url);
    expect(url.pathname).toBe('/v2/server-connections/ec2/proxy/v2/ws');
    expect(url.searchParams.get('sessionId')).toBe('s1');
    expect(url.searchParams.get('offset')).toBe('0');
  });

  it('never puts the long-lived browser pass in a PTY URL', () => {
    let token = 'tm8s_first.secret/value';
    ptyTransport.openSession('s1', '', () => token);
    expect(new URL(last().url).searchParams.get('token')).toBeNull();
    expect(ptyTransport.endpointFor('s1')?.authToken).toBe(token);

    last().text({ type: 'attached', base: 0, gap: 0, next: 42, hasReplay: false, epoch: 'e1' });
    token = 'tm8s_second.new-secret';
    ptyTransport.suspend('s1');
    ptyTransport.resume('s1');

    const resumed = new URL(last().url);
    expect(resumed.searchParams.get('offset')).toBe('42');
    expect(resumed.searchParams.get('token')).toBeNull();
    expect(ptyTransport.endpointFor('s1')?.authToken).toBe(token);
  });

  it('mints a fresh one-shot grant on reconnect and carries it only in the protocol offer', async () => {
    let minted = 0;
    const mint = async () => {
      minted += 1;
      return {
        workSessionId: 's1',
        url: '/v2/ws?sessionId=s1&mode=drive',
        protocol: 'ws' as const,
        mode: 'drive' as const,
        token: `tm8g_grant-${minted}`,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      };
    };
    ptyTransport.openSession('s1', '', undefined, mint, 'drive');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(last().url).not.toContain('tm8g_');
    expect(last().protocols).toEqual(['tm8-pty-v1', 'tm8-grant.tm8g_grant-1']);

    last().text({ type: 'attached', base: 0, gap: 0, next: 42, hasReplay: false, epoch: 'e1' });
    ptyTransport.suspend('s1');
    ptyTransport.resume('s1');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(last().url).not.toContain('tm8g_');
    expect(new URL(last().url).searchParams.get('offset')).toBe('42');
    expect(last().protocols[1]).toBe('tm8-grant.tm8g_grant-2');
  });

  it('keeps the selected server relay when the PTY reconnects', () => {
    ptyTransport.openSession('s1', '/v2/server-connections/ec2/proxy/');
    last().text({ type: 'attached', base: 0, gap: 0, next: 42, hasReplay: false, epoch: 'e1' });
    ptyTransport.suspend('s1');
    ptyTransport.resume('s1');
    const url = new URL(last().url);
    expect(url.pathname).toBe('/v2/server-connections/ec2/proxy/v2/ws');
    expect(url.searchParams.get('offset')).toBe('42');
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
    // Until the snapshot lands, a reconnect must not resume inside a stream
    // whose bytes this client never received.
    expect(ptyTransport.__received('s1')).toBe(0);
    last().bin('SNAPSHOT');
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

  it('preserves high-bit mouse report bytes without UTF-8 expansion', () => {
    ptyTransport.openSession('s1');
    ptyTransport.writeBinary('s1', '\x1b[M`\xc8\xff');
    expect(Array.from(last().sent.at(-1) as Uint8Array)).toEqual([27, 91, 77, 96, 200, 255]);
  });

  it('input and resize produced while disconnected are flushed in FIFO order on open', () => {
    // The real sequence: the terminal mounts and fits itself immediately, which
    // races openSession()'s connect. User input during that same window must not
    // vanish either.
    ptyTransport.openSession('s1');
    const ws = last();
    ws.readyState = 0; // CONNECTING — not yet OPEN
    ptyTransport.write('s1', 'TM8-ECHO');
    ptyTransport.resize('s1', 205, 51);
    expect(ws.sent).toEqual([]); // nothing sent while connecting

    ws.readyState = 1;
    ws.onopen?.();
    expect(new TextDecoder().decode(ws.sent[0] as Uint8Array)).toBe('TM8-ECHO');
    expect(ws.sent[1]).toBe(JSON.stringify({ type: 'resize', cols: 205, rows: 51 }));
  });

  it('preserves queued frame order rather than silently replacing input-adjacent frames', () => {
    ptyTransport.openSession('s1');
    const ws = last();
    ws.readyState = 0;
    ptyTransport.resize('s1', 100, 20);
    ptyTransport.write('s1', 'between');
    ptyTransport.resize('s1', 205, 51);
    ws.readyState = 1;
    ws.onopen?.();
    expect(ws.sent[0]).toBe(JSON.stringify({ type: 'resize', cols: 100, rows: 20 }));
    expect(new TextDecoder().decode(ws.sent[1] as Uint8Array)).toBe('between');
    expect(ws.sent[2]).toBe(JSON.stringify({ type: 'resize', cols: 205, rows: 51 }));
  });

  it('fails closed on pending overflow: discards the whole queue and every tail frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ptyTransport.openSession('s1');
    const ws = last();
    ws.readyState = 0;

    ptyTransport.write('s1', 'prefix-command ');
    ptyTransport.write('s1', 'x'.repeat(256 * 1024 + 1));
    ptyTransport.write('s1', 'dangerous-tail\r');

    ws.readyState = 1;
    ws.onopen?.();
    expect(ws.sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    // Successful open clears the latch; only input produced afterwards flows.
    ptyTransport.write('s1', 'after-open');
    expect(new TextDecoder().decode(ws.sent[0] as Uint8Array)).toBe('after-open');
    warn.mockRestore();
  });

  it('requestFullReplay replaces the socket and reconnects at offset 0', () => {
    ptyTransport.openSession('s1');
    const old = last();
    old.text({ type: 'attached', base: 0, gap: 0, next: 480, hasReplay: false, epoch: 'e1' });
    old.bin('live');
    expect(ptyTransport.__received('s1')).toBe(484);

    ptyTransport.requestFullReplay('s1');
    const replacement = last();
    expect(replacement).not.toBe(old);
    expect(old.readyState).toBe(FakeWebSocket.CLOSED);
    expect(offsetOf(replacement)).toBe(0);
    expect(ptyTransport.__received('s1')).toBe(0);
  });

  it('forwards size.live so views can distinguish peer resizes from attach snapshots', () => {
    const sizes: Array<{ cols: number; rows: number; live?: boolean }> = [];
    const offSize = ptyTransport.onSize((_id, size) => sizes.push(size));
    ptyTransport.openSession('s1');
    last().text({ type: 'size', cols: 120, rows: 31 });
    last().text({ type: 'size', cols: 180, rows: 44, live: true });
    expect(sizes).toEqual([
      { cols: 120, rows: 31, live: undefined },
      { cols: 180, rows: 44, live: true },
    ]);
    offSize();
  });

  it('stagger-reconnects on wake and repeated wakes do not duplicate or re-slot timers', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    ptyTransport.openSession('s1');
    ptyTransport.openSession('s2');
    ptyTransport.openSession('s3');
    const original = FakeWebSocket.instances.slice();
    for (const socket of original) socket.close();
    expect(FakeWebSocket.instances).toHaveLength(3);

    window.dispatchEvent(new Event('online'));
    // Exactly one reconnects immediately; the others own one stagger slot each.
    expect(FakeWebSocket.instances).toHaveLength(4);
    window.dispatchEvent(new Event('online'));
    expect(FakeWebSocket.instances).toHaveLength(4);

    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(6);
    vi.useRealTimers();
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

  /**
   * 187 — the refusal latch, and the one reason it may be lifted.
   *
   * A refusal stops the reconnect loop, which is the whole point; the risk it
   * creates is the opposite one, a latch that outlives the condition. Signing
   * in is the only event that can change a refusal's answer without somebody
   * else acting, so it is the only event allowed to clear one — and clearing
   * it has to reach the SURFACE, not just the map, or the user follows an
   * instruction into a working socket wearing a stale placeholder.
   */
  it('a refused attach latches: it stops the dial and says so exactly once', async () => {
    const refusals: string[] = [];
    const off = ptyTransport.onAttachRefused((id, r) => refusals.push(`${id}:${r.reason}`));
    ptyTransport.openSession('s1', '', undefined, async () => {
      throw new PtyAttachRefused('unauthorized', 'view', 'no pass');
    }, 'view');
    await vi.waitFor(() => expect(refusals).toEqual(['s1:unauthorized']));
    const dialled = FakeWebSocket.instances.length;

    // Every automatic path lands in `_ensureSocket`, and none of them may re-ask.
    ptyTransport.suspend('s1');
    ptyTransport.resume('s1');
    window.dispatchEvent(new Event('online'));
    expect(FakeWebSocket.instances.length).toBe(dialled);
    off();
  });

  it('clearAuthRefusals lifts an unauthorized latch, re-dials, AND announces the clear', async () => {
    const refusals: string[] = [];
    const cleared: string[] = [];
    const offR = ptyTransport.onAttachRefused((id, r) => refusals.push(`${id}:${r.reason}`));
    const offC = ptyTransport.onAttachRefusalCleared((id) => cleared.push(id));

    let deny = true;
    ptyTransport.openSession('s1', '', undefined, async () => {
      if (deny) throw new PtyAttachRefused('unauthorized', 'view', 'no pass');
      return {
        workSessionId: 's1',
        url: '/v2/ws?sessionId=s1&mode=view',
        protocol: 'ws' as const,
        mode: 'view' as const,
        token: 'tm8g_after-sign-in',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      };
    }, 'view');
    await vi.waitFor(() => expect(refusals).toEqual(['s1:unauthorized']));
    const dialled = FakeWebSocket.instances.length;

    deny = false;
    ptyTransport.clearAuthRefusals();

    // The announcement is synchronous with the clear; the socket follows.
    // Without it `LiveTerminal`'s placeholder state has no path back to null
    // short of a remount, and nothing remounts on sign-in.
    expect(cleared).toEqual(['s1']);
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(dialled + 1));

    offR();
    offC();
  });

  it('clearAuthRefusals leaves a private session private', async () => {
    const cleared: string[] = [];
    const refusals: string[] = [];
    const offR = ptyTransport.onAttachRefused((id, r) => refusals.push(`${id}:${r.reason}`));
    const offC = ptyTransport.onAttachRefusalCleared((id) => cleared.push(id));

    ptyTransport.openSession('s2', '', undefined, async () => {
      throw new PtyAttachRefused('forbidden', 'view', 'not shared');
    }, 'view');
    await vi.waitFor(() => expect(refusals).toEqual(['s2:forbidden']));
    const dialled = FakeWebSocket.instances.length;

    ptyTransport.clearAuthRefusals();
    // Signing in does not make somebody else's decision go away.
    expect(cleared).toEqual([]);
    expect(FakeWebSocket.instances.length).toBe(dialled);

    offR();
    offC();
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
