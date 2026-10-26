import { afterEach, describe, expect, it } from 'vitest';
import { PtyHostService } from '../src/pty/PtyHostService.js';
import { TerminalStateMirror } from '../src/pty/TerminalStateMirror.js';
import type { FrameSink } from '../src/pty/types.js';

// The headless mirror is fed the coalesced frame in flushOutput and built
// lazily. These pin the two things that change could break: a mirror read or
// snapshot must cover every byte the OutputBuffer counts (even bytes still
// waiting in sendBuf), and a lazily built mirror must equal an eager one.

const quiet = { error() {}, warn() {}, info() {}, debug() {} };
// A coalescing window no test outlives: bytes stay in sendBuf until something
// flushes them, which makes "the mirror read flushed first" observable.
const PARKED = { coalesceMs: 60_000, coalesceMaxBytes: 1 << 30 };
const ENV = { PATH: '/usr/bin:/bin' };

interface EntryView {
  state: TerminalStateMirror | null;
  sendBytes: number;
  output: { totalBytes: number; startOffset: number; replayFrom(n: number): { data: Buffer } };
}
const entryOf = (host: PtyHostService, id: string) =>
  (host as unknown as { sessions: Map<string, EntryView> }).sessions.get(id)!;
/** Raw output so far, read off the ring WITHOUT flushing sendBuf. */
const ringText = (host: PtyHostService, id: string) =>
  entryOf(host, id)?.output.replayFrom(0).data.toString('utf8') ?? '';
const bracketed = async (host: PtyHostService, id: string) => {
  const h = host as unknown as {
    settleMirror(e: EntryView): Promise<void>;
    bracketedPaste(e: EntryView): boolean;
  };
  await h.settleMirror(entryOf(host, id));
  return h.bracketedPaste(entryOf(host, id));
};

function sink(): FrameSink & { frames: Buffer[]; text(): string } {
  const frames: Buffer[] = [];
  return {
    frames,
    readyState: 1,
    send: (data) => frames.push(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')),
    close: () => {},
    text: () => Buffer.concat(frames).toString('utf8'),
  };
}

let hosts: PtyHostService[] = [];
const newHost = (opts: ConstructorParameters<typeof PtyHostService>[0] = {}) => {
  const host = new PtyHostService({ logger: quiet, defaultShell: '/bin/sh', ...opts });
  hosts.push(host);
  return host;
};
afterEach(() => {
  for (const host of hosts) host.shutdownAll();
  hosts = [];
});

describe('TerminalStateMirror feed', () => {
  it('one coalesced frame parses to the same state as the chunks it joins', async () => {
    // Split mid-CSI and mid-UTF-8 code point: the parser is a stream, so the
    // chunk boundaries must not matter.
    const stream = Buffer.from('\x1b[?2004h\x1b[1;31mred €uro\x1b[0m\r\nline two\x1b[2;3Hx', 'utf8');
    const cuts = [3, 9, 17, 19, 30];
    const perChunk = new TerminalStateMirror(40, 10);
    let pos = 0;
    for (const cut of [...cuts, stream.length]) {
      perChunk.append(stream.subarray(pos, cut));
      pos = cut;
    }
    const coalesced = new TerminalStateMirror(40, 10);
    coalesced.append(stream);
    expect((await coalesced.snapshot()).toString()).toBe((await perChunk.snapshot()).toString());
    expect(coalesced.bracketedPaste).toBe(true);
    perChunk.dispose();
    coalesced.dispose();
  });
});

describe('PtyHostService mirror boundaries', () => {
  it('builds no mirror for a PTY nobody reads that stays under the ring cap', async () => {
    const host = newHost();
    host.spawn({ sessionId: 'unread', command: 'printf unread-output; sleep 5', cwd: '/tmp', env: ENV });
    await expect.poll(() => ringText(host, 'unread'), { timeout: 10_000 }).toContain('unread-output');
    host.getReplay('unread', 0); // a raw replay is not a mirror read
    expect(entryOf(host, 'unread').state).toBeNull();
  }, 20_000);

  it('readScreen covers bytes still parked in the coalescing buffer', async () => {
    const host = newHost(PARKED);
    host.spawn({ sessionId: 'parked', command: 'sleep 0.3; printf parked-marker; sleep 5', cwd: '/tmp', env: ENV });
    await host.readScreen('parked'); // build now, so the next read cannot lean on the build's flush
    await expect.poll(() => ringText(host, 'parked'), { timeout: 10_000 }).toContain('parked-marker');
    expect(entryOf(host, 'parked').sendBytes).toBeGreaterThan(0); // not yet flushed
    expect(await host.readScreen('parked')).toContain('parked-marker');
    expect(entryOf(host, 'parked').sendBytes).toBe(0);
  }, 20_000);

  it('cursor-region reads (prompt verify) see parked bytes too', async () => {
    const host = newHost(PARKED);
    host.spawn({ sessionId: 'cursor', command: 'sleep 0.3; printf cursor-token; sleep 5', cwd: '/tmp', env: ENV });
    await host.readScreen('cursor');
    await expect.poll(() => ringText(host, 'cursor'), { timeout: 10_000 }).toContain('cursor-token');
    const stillAtCursor = (host as unknown as {
      promptStillAtCursor(e: EntryView, token: string): Promise<boolean>;
    }).promptStillAtCursor(entryOf(host, 'cursor'), 'cursor-token');
    expect(await stillAtCursor).toBe(true);
  }, 20_000);

  it('a snapshot covers exactly [0, next): parked bytes are in it, later bytes arrive live once', async () => {
    // Overflow a 2 KiB ring so attach from 0 takes the snapshot path.
    const host = newHost({ ...PARKED, outputCapBytes: 2048 });
    const id = 'snap';
    host.spawn({
      sessionId: id,
      command: 'seq 1 2000; printf MARK-A; sleep 1; printf MARK-B; sleep 5',
      cwd: '/tmp',
      env: ENV,
    });
    await expect.poll(() => ringText(host, id), { timeout: 10_000 }).toContain('MARK-A');
    const entry = entryOf(host, id);
    expect(entry.sendBytes).toBeGreaterThan(0); // MARK-A is still coalescing
    const totalAtAttach = entry.output.totalBytes;

    const client = sink();
    const attached = await host.attach(id, client, 0);
    expect(attached?.replayKind).toBe('snapshot');
    expect(attached?.next).toBe(totalAtAttach);
    const snapshot = attached!.replay.toString('utf8');
    expect(snapshot).toContain('MARK-A');
    expect(snapshot).not.toContain('MARK-B');
    expect(client.text()).toBe(snapshot); // nothing parked leaked out live

    await expect.poll(() => ringText(host, id), { timeout: 10_000 }).toContain('MARK-B');
    expect(entry.sendBytes).toBeGreaterThan(0); // MARK-B is parked
    // A direct state snapshot (no attach handshake flushing for it) still
    // covers the parked bytes, and its `next` is the ring's total.
    const direct = await host.getStateSnapshot(id)!;
    expect(direct.next).toBe(entry.output.totalBytes);
    expect(direct.data.toString('utf8')).toContain('MARK-B');
    const live = Buffer.concat(client.frames.slice(1)).toString('utf8');
    expect(live).toBe('MARK-B');
    expect(attached!.next + Buffer.byteLength(live)).toBe(entry.output.totalBytes);
  }, 20_000);

  it('a lazily built mirror keeps modes set before the ring evicted them', async () => {
    const host = newHost({ outputCapBytes: 2048 });
    const id = 'evict';
    // Assert bracketed paste, then push the escape far out of a 2 KiB ring.
    host.spawn({ sessionId: id, command: "printf '\\033[?2004h'; seq 1 3000; sleep 5", cwd: '/tmp', env: ENV });
    await expect.poll(() => ringText(host, id), { timeout: 10_000 }).toContain('\n3000');
    const entry = entryOf(host, id);
    expect(entry.output.startOffset).toBeGreaterThan(0); // the escape is gone from the ring
    expect(entry.state).not.toBeNull(); // so the mirror was built before it went
    expect(await bracketed(host, id)).toBe(true);
    expect(await host.readScreen(id)).toContain('3000');
  }, 20_000);

  it('a lazy build replays resizes at their offsets, matching an eager mirror', async () => {
    const command = 'printf "%s\\n" AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; sleep 1; printf "%s\\n" BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB; sleep 5';
    const lazy = newHost();
    const eager = newHost();
    for (const host of [lazy, eager]) {
      host.spawn({ sessionId: 'resize', command, cwd: '/tmp', env: ENV, cols: 20, rows: 6 });
    }
    void eager.readScreen('resize'); // build at spawn, fed live from here on
    expect(entryOf(eager, 'resize').state).not.toBeNull();
    for (const host of [lazy, eager]) {
      await expect.poll(() => ringText(host, 'resize'), { timeout: 10_000 }).toContain('AAAA');
      host.resize('resize', 50, 6);
      await expect.poll(() => ringText(host, 'resize'), { timeout: 10_000 }).toContain('BBBB');
    }
    expect(entryOf(lazy, 'resize').state).toBeNull();
    const [lazyScreen, eagerScreen] = await Promise.all([lazy.readScreen('resize'), eager.readScreen('resize')]);
    expect(lazyScreen).toContain('BBBB');
    expect(lazyScreen).toBe(eagerScreen);
    const [a, b] = await Promise.all([lazy.getStateSnapshot('resize'), eager.getStateSnapshot('resize')]);
    expect((await a)!.data.toString()).toBe((await b)!.data.toString());
  }, 20_000);

  it('mirror reads after exit or kill report no screen instead of building one', async () => {
    const host = newHost();
    host.spawn({ sessionId: 'gone', command: 'printf bye; sleep 5', cwd: '/tmp', env: ENV });
    await expect.poll(() => ringText(host, 'gone'), { timeout: 10_000 }).toContain('bye');
    const entry = entryOf(host, 'gone');
    host.kill('gone');
    expect(await host.readScreen('gone')).toBeNull();
    expect(host.getStateSnapshot('gone')).toBeNull();
    expect(entry.state).toBeNull();
  }, 20_000);
});
