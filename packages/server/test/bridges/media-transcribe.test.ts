/**
 * 442 §3: a bridged message with media is delivered once its files are in and
 * its voice notes transcribed (BridgeMediaFetcher.settle), transcriptions run
 * one at a time on this host, and the local transcriber program is found and
 * run with the audio on stdin (transcribe.ts). No database: the doors are fakes.
 */
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BridgeMediaFetcher } from '../../src/bridges/runtime/media.js';
import { createLocalTranscriber, findTranscriber, type Transcriber } from '../../src/bridges/runtime/transcribe.js';

interface Item { messageId: string; idx: number; handle: string; kind: string; mime: string | null }

function harness(items: Item[], opts: { fetchMs?: number; transcribe?: Transcriber } = {}) {
  const due = items.map((i) => ({ ...i, spaceId: 's', connectionId: 'c', conversationId: 'g', runtimeId: 'rt' }));
  const attached = new Set<string>();
  const calls: { fn: string; args: unknown[] }[] = [];
  const db = {
    rpc: async (_claims: unknown, fn: string, args: unknown[] = []) => {
      calls.push({ fn, args });
      if (fn === 'internal.bridge_media_take') return due.splice(0, due.length);
      if (fn === 'internal.bridge_media_attach') { attached.add(`${args[0]}/${args[1]}`); return 'file-id'; }
      if (fn === 'internal.bridge_media_pending') return items.filter((i) => i.messageId === args[0] && !attached.has(`${i.messageId}/${i.idx}`)).length;
      return true;
    },
  };
  const hub = {
    connectedRuntimes: () => ['rt'],
    fetchMedia: async (_rt: string, req: { handle: string }) => {
      await new Promise((r) => setTimeout(r, opts.fetchMs ?? 5));
      return { requestId: 'x', mime: null, data: Buffer.from(`bytes of ${req.handle}`).toString('base64') };
    },
  };
  const blobStore = { storagePath: (_s: string, id: string) => `p/${id}`, writeUpload: async () => undefined };
  const fetcher = new BridgeMediaFetcher({
    db: db as never, hub: hub as never, blobStore: blobStore as never, maxBytes: 1_000_000,
    ...(opts.transcribe ? { transcribe: opts.transcribe } : {}),
  });
  const transcripts = () => calls.filter((c) => c.fn === 'internal.bridge_media_transcript').map((c) => c.args);
  return { fetcher, calls, transcripts };
}

const voice = (messageId: string, idx = 0): Item => ({ messageId, idx, handle: `H-${messageId}-${idx}`, kind: 'audio', mime: 'audio/ogg; codecs=opus' });

describe('BridgeMediaFetcher.settle (442 §3)', () => {
  it('resolves only after the voice note is attached and its transcript recorded', async () => {
    const heard: Buffer[] = [];
    const h = harness([voice('m1')], {
      transcribe: async (audio) => {
        heard.push(audio);
        await new Promise((r) => setTimeout(r, 50));
        return { text: 'hello from the family', language: 'te' };
      },
    });
    await h.fetcher.settle('m1', 5_000);
    expect(h.calls.some((c) => c.fn === 'internal.bridge_media_attach')).toBe(true);
    expect(h.transcripts()).toEqual([['m1', 0, 'hello from the family', 'te', null]]);
    expect(heard.map((b) => b.toString())).toEqual(['bytes of H-m1-0']);
  });

  it('records a failed transcription with its reason and still resolves', async () => {
    const h = harness([voice('m2')], { transcribe: async () => { throw new Error('too_long'); } });
    await h.fetcher.settle('m2', 5_000);
    expect(h.transcripts()).toEqual([['m2', 0, null, null, 'too_long']]);
  });

  it('runs one transcription at a time', async () => {
    let running = 0, most = 0;
    const h = harness([voice('m3'), voice('m4'), voice('m4', 1)], {
      transcribe: async () => {
        running += 1; most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 30));
        running -= 1;
        return { text: 'words', language: null };
      },
    });
    await Promise.all([h.fetcher.settle('m3', 5_000), h.fetcher.settle('m4', 5_000)]);
    expect(most).toBe(1);
    expect(h.transcripts().map((a) => `${a[0]}/${a[1]}`).sort()).toEqual(['m3/0', 'm4/0', 'm4/1']);
  });

  it('gives up at its timeout while a transcription is still running', async () => {
    const h = harness([voice('m5')], { transcribe: () => new Promise(() => undefined) });
    const started = Date.now();
    await h.fetcher.settle('m5', 300);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(h.transcripts()).toEqual([]);
  });

  it('does not transcribe a photo, and without a transcriber a voice note keeps its file only', async () => {
    const photo = harness([{ messageId: 'm6', idx: 0, handle: 'H-photo', kind: 'image', mime: 'image/jpeg' }], {
      transcribe: async () => { throw new Error('must not be called'); },
    });
    await photo.fetcher.settle('m6', 5_000);
    expect(photo.calls.filter((c) => c.fn === 'internal.bridge_media_attach')).toHaveLength(1);
    expect(photo.transcripts()).toEqual([]);
    const silent = harness([voice('m7')]);
    await silent.fetcher.settle('m7', 5_000);
    expect(silent.calls.filter((c) => c.fn === 'internal.bridge_media_attach')).toHaveLength(1);
    expect(silent.transcripts()).toEqual([]);
  });

  it('hears an audio file sent as a document', async () => {
    const h = harness([{ messageId: 'm8', idx: 0, handle: 'H-mp3', kind: 'document', mime: 'audio/mpeg' }], {
      transcribe: async () => ({ text: 'a recorded call', language: 'en' }),
    });
    await h.fetcher.settle('m8', 5_000);
    expect(h.transcripts()).toEqual([['m8', 0, 'a recorded call', 'en', null]]);
  });
});

/** A process that exists and is not a zombie waiting to be reaped. */
function running(pid: number): boolean {
  const stat = `/proc/${pid}/stat`;
  if (!existsSync(stat)) return false;
  try {
    return readFileSync(stat, 'utf8').replace(/^.*\) /s, '')[0] !== 'Z';
  } catch {
    return false;
  }
}

describe('the local transcriber (transcribe.ts)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm8-transcribe-test-'));
  const program = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  it('passes the audio on stdin as "-" and reads the JSON it prints', async () => {
    const echo = program('echo-stt', 'test "$1" = "-" || exit 9\nn=$(wc -c)\nprintf \'{"text":"%s bytes","language":"te","durationSec":1.0}\' "$n"');
    await expect(createLocalTranscriber(echo)(Buffer.alloc(1234, 1), 'audio/ogg')).resolves.toEqual({ text: '1234 bytes', language: 'te' });
  });

  it('turns exit 3, other exits and output that is not its JSON into reasons', async () => {
    const audio = Buffer.from('x');
    await expect(createLocalTranscriber(program('long-stt', 'cat >/dev/null; exit 3'))(audio, null)).rejects.toThrow('too_long');
    await expect(createLocalTranscriber(program('bad-stt', 'cat >/dev/null; echo "cannot decode" >&2; exit 2'))(audio, null))
      .rejects.toThrow('exited 2: cannot decode');
    await expect(createLocalTranscriber(program('noise-stt', 'cat >/dev/null; echo hello'))(audio, null)).rejects.toThrow('printed no JSON');
    await expect(createLocalTranscriber(program('notext-stt', 'cat >/dev/null; echo \'{"language":"te"}\''))(audio, null)).rejects.toThrow('printed no text');
  });

  it('at its timeout fails at once and kills what the program started', async () => {
    // The sleep outlives a killed sh and holds the pipes: only a process-group kill ends it.
    const pidFile = join(dir, 'hang.pid');
    const hang = program('hang-stt', `sleep 30 &\necho $! > ${pidFile}\nwait`);
    const started = Date.now();
    await expect(createLocalTranscriber(hang, { timeoutMs: 300 })(Buffer.from('x'), null)).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(2_000);
    const sleeper = Number(readFileSync(pidFile, 'utf8'));
    expect(sleeper).toBeGreaterThan(1);
    await vi.waitFor(() => expect(running(sleeper)).toBe(false), { timeout: 2_000 });
  });

  it('is found by TM8_TRANSCRIBE_BIN, on PATH, or in ~/.local/bin; set but empty turns it off', () => {
    const own = program('own-stt', 'exit 0');
    expect(findTranscriber({ TM8_TRANSCRIBE_BIN: own })).toBe(own);
    expect(findTranscriber({ TM8_TRANSCRIBE_BIN: '', PATH: dir })).toBeNull();
    expect(findTranscriber({ TM8_TRANSCRIBE_BIN: join(dir, 'missing') })).toBeNull();
    const onPath = join(dir, 'bin');
    mkdirSync(onPath);
    writeFileSync(join(onPath, 'tm8-transcribe'), '#!/bin/sh\n');
    chmodSync(join(onPath, 'tm8-transcribe'), 0o755);
    expect(findTranscriber({ PATH: `/nonexistent:${onPath}` })).toBe(join(onPath, 'tm8-transcribe'));
    const home = join(dir, 'home');
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'tm8-transcribe'), '#!/bin/sh\n');
    chmodSync(join(home, '.local', 'bin', 'tm8-transcribe'), 0o755);
    expect(findTranscriber({ PATH: '/nonexistent', HOME: home })).toBe(join(home, '.local', 'bin', 'tm8-transcribe'));
    expect(findTranscriber({ PATH: '/nonexistent', HOME: join(dir, 'nohome') })).toBeNull();
  });
});
