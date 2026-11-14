/**
 * Inbound media become file entities (BRIDGE-ENTITY-DESIGN §2.3 step 3,
 * migration 413 §4). Inbound stores one `bridge_media` row per media item with
 * the runtime's self-contained fetch handle (D39); this asks the runtime for
 * the bytes (`media.fetch`), writes them to the blob store and attaches a file
 * entity to the log message, exactly as a message attachment is attached.
 *
 * Nothing here is on the inbound request path: the route kicks a pump after
 * commit, and the watchdog pumps every tick, so a fetch a restart interrupted
 * is retried. A fetch the runtime says can never succeed (too large, the chat
 * is no longer connected) stops at once; anything else backs off and stops
 * after five attempts.
 *
 * 442 §2/§3: the file is attached to every routed copy too (the SQL does it),
 * the route delivers a message only once `settle` says its media are in, and
 * a voice note (kind `audio`) is transcribed on this host after it is attached,
 * one at a time, its text appended to the message and its copies. A restart
 * loses a transcript in flight; the voice note keeps its file.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { Db } from '../../db/types.js';
import type { W2BlobStore } from '../../files/w2-blob-store.js';
import { bridgesWorkerClaims } from '../outbox.js';
import type { BridgeRuntimeHub } from './hub.js';
import type { Transcriber } from './transcribe.js';

interface DueMedia {
  messageId: string;
  idx: number;
  handle: string;
  kind: string;
  mime: string | null;
  spaceId: string;
  connectionId: string;
  conversationId: string;
  runtimeId: string;
}

export interface BridgeMediaFetcherOptions {
  readonly db: Db;
  readonly hub: Pick<BridgeRuntimeHub, 'connectedRuntimes' | 'fetchMedia'>;
  readonly blobStore: Pick<W2BlobStore, 'storagePath' | 'writeUpload'>;
  /** The node's file size ceiling; the runtime refuses anything larger (tooLarge). */
  readonly maxBytes: number;
  /** Voice notes to text on this host (442 §3). Absent: a voice note keeps its file only. */
  readonly transcribe?: Transcriber;
  readonly log?: (line: string) => void;
}

/** How long `settle` waits for the bytes themselves before it lets delivery go on. */
const FETCH_WAIT_MS = 30_000;
const POLL_MS = 300;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A WhatsApp voice note is kind `audio`; an audio file sent as a document is heard too. */
function isVoice(kind: string, mime: string | null): boolean {
  return kind === 'audio' || (mime ?? '').toLowerCase().startsWith('audio/');
}

/** Resolves when `p` settles or at `deadline`, whichever is first; never rejects. */
async function until(p: Promise<unknown>, deadline: number): Promise<void> {
  const left = deadline - Date.now();
  if (left <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    p.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, left); }),
  ]);
  clearTimeout(timer);
}

export class BridgeMediaFetcher {
  private running: Promise<number> | null = null;
  /** The tail of the transcription queue (one at a time). */
  private transcriptions: Promise<void> = Promise.resolve();
  /** A message's voice notes still being fetched or transcribed, for `settle`. */
  private readonly transcribing = new Map<string, Promise<void>>();

  constructor(private readonly o: BridgeMediaFetcherOptions) {}

  /**
   * 442 §3: resolves once the message's media are attached (or failed, or
   * backing off after a failure) and its voice notes transcribed, or at
   * `timeoutMs`, whichever is first, so the delivery that follows carries the
   * files and the words. The bytes get at most 30 seconds of that. Never throws.
   */
  async settle(messageId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const fetchDeadline = Math.min(deadline, Date.now() + FETCH_WAIT_MS);
    try {
      for (;;) {
        // A pass already running may predate this message's rows; the next one takes them.
        await until(this.kick(), fetchDeadline);
        const pending = await this.o.db.rpc<number>(bridgesWorkerClaims(), 'internal.bridge_media_pending', [messageId]);
        if (!pending || Date.now() >= fetchDeadline) break;
        await sleep(Math.min(POLL_MS, Math.max(0, fetchDeadline - Date.now())));
      }
      const words = this.transcribing.get(messageId);
      if (words) await until(words, deadline);
    } catch (err) {
      this.o.log?.(`[bridges] settling the media of ${messageId} failed: ${(err as Error).message}`);
    }
  }

  /** Coalesced: concurrent kicks share one pass. Never throws. */
  kick(): Promise<number> {
    if (!this.running) {
      this.running = this.pump()
        .catch((err) => {
          this.o.log?.(`[bridges] media pump failed: ${(err as Error).message}`);
          return 0;
        })
        .finally(() => { this.running = null; });
    }
    return this.running;
  }

  private async pump(): Promise<number> {
    const runtimes = this.o.hub.connectedRuntimes();
    if (runtimes.length === 0) return 0;
    const due = await this.o.db.rpc<DueMedia[]>(bridgesWorkerClaims(), 'internal.bridge_media_take', [runtimes, 5]);
    let attached = 0;
    for (const item of due ?? []) {
      try {
        if (await this.fetchOne(item)) attached += 1;
      } catch (err) {
        await this.fail(item, (err as Error).message, true);
      }
    }
    return attached;
  }

  private fetchOne(item: DueMedia): Promise<boolean> {
    const attached = this.fetchAndAttach(item);
    if (this.o.transcribe && isVoice(item.kind, item.mime)) {
      // Tracked from before the bytes arrive, so `settle` never finds the note
      // attached but not yet queued for transcription.
      this.track(item.messageId, attached.then(
        (got) => (got ? this.transcribeQueued(item, got.bytes, got.mime) : undefined),
        () => undefined,
      ));
    }
    return attached.then((got) => got !== null);
  }

  /** The bytes, stored and attached (442 §2: to the message and its copies); null when the fetch failed. */
  private async fetchAndAttach(item: DueMedia): Promise<{ bytes: Buffer; mime: string | null } | null> {
    const frame = await this.o.hub.fetchMedia(item.runtimeId, {
      requestId: randomUUID(),
      connectionId: item.connectionId,
      conversationId: item.conversationId,
      handle: item.handle,
      maxBytes: this.o.maxBytes,
    });
    if ('error' in frame) {
      // Too large, or a chat the runtime no longer serves: retrying cannot help.
      const final = frame.tooLarge === true || frame.error === 'unknown_connection' || frame.error === 'not_connected';
      await this.fail(item, frame.tooLarge ? 'too_large' : frame.error, !final);
      return null;
    }
    const bytes = Buffer.from(frame.data, 'base64');
    if (bytes.length > this.o.maxBytes) {
      await this.fail(item, 'too_large', false);
      return null;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const storagePath = this.o.blobStore.storagePath(item.spaceId, randomUUID());
    await this.o.blobStore.writeUpload({
      stream: (async function* () { yield bytes; })(),
      storagePath,
      expectedSpaceId: item.spaceId,
      expectedSizeBytes: bytes.length,
      expectedChecksumSha256: sha256,
    });
    const mime = frame.mime ?? item.mime;
    await this.o.db.rpc(bridgesWorkerClaims(), 'internal.bridge_media_attach',
      [item.messageId, item.idx, storagePath, bytes.length, sha256, mime]);
    return { bytes, mime };
  }

  /**
   * One voice note through the transcriber, after any already queued (Whisper
   * takes several cores while it runs), its outcome recorded either way
   * (442 §3). Never rejects.
   */
  private transcribeQueued(item: DueMedia, audio: Buffer, mime: string | null): Promise<void> {
    const transcribe = this.o.transcribe;
    if (!transcribe) return Promise.resolve();
    const run = this.transcriptions.then(async () => {
      let text: string | null = null;
      let language: string | null = null;
      let error: string | null = null;
      try {
        ({ text, language } = await transcribe(audio, mime));
      } catch (err) {
        error = (err as Error).message;
        this.o.log?.(`[bridges] transcribing ${item.messageId}/${item.idx} failed: ${error}`);
      }
      await this.o.db.rpc(bridgesWorkerClaims(), 'internal.bridge_media_transcript', [item.messageId, item.idx, text, language, error]);
    }).catch((err) => this.o.log?.(`[bridges] recording the transcript of ${item.messageId} failed: ${(err as Error).message}`));
    this.transcriptions = run;
    return run;
  }

  /** Adds `work` to what `settle` waits for on `messageId`. */
  private track(messageId: string, work: Promise<void>): void {
    const earlier = this.transcribing.get(messageId);
    const all = earlier ? Promise.all([earlier, work]).then(() => undefined) : work;
    this.transcribing.set(messageId, all);
    void all.finally(() => {
      if (this.transcribing.get(messageId) === all) this.transcribing.delete(messageId);
    });
  }

  private async fail(item: DueMedia, reason: string, retry: boolean): Promise<void> {
    await this.o.db.rpc(bridgesWorkerClaims(), 'internal.bridge_media_fail', [item.messageId, item.idx, reason, retry])
      .catch((err) => this.o.log?.(`[bridges] media fail record failed: ${(err as Error).message}`));
  }
}
