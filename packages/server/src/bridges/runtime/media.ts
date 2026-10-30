/**
 * Inbound media become file entities (BRIDGE-ENTITY-DESIGN §2.3 step 3,
 * migration 402 §4). Inbound stores one `bridge_media` row per media item with
 * the runtime's self-contained fetch handle (D39); this asks the runtime for
 * the bytes (`media.fetch`), writes them to the blob store and attaches a file
 * entity to the log message, exactly as a message attachment is attached.
 *
 * Nothing here is on the inbound request path: the route kicks a pump after
 * commit, and the watchdog pumps every tick, so a fetch a restart interrupted
 * is retried. A fetch the runtime says can never succeed (too large, the chat
 * is no longer connected) stops at once; anything else backs off and stops
 * after five attempts.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { Db } from '../../db/types.js';
import type { W2BlobStore } from '../../files/w2-blob-store.js';
import { bridgesWorkerClaims } from '../outbox.js';
import type { BridgeRuntimeHub } from './hub.js';

interface DueMedia {
  messageId: string;
  idx: number;
  handle: string;
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
  readonly log?: (line: string) => void;
}

export class BridgeMediaFetcher {
  private running: Promise<number> | null = null;

  constructor(private readonly o: BridgeMediaFetcherOptions) {}

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

  private async fetchOne(item: DueMedia): Promise<boolean> {
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
      return false;
    }
    const bytes = Buffer.from(frame.data, 'base64');
    if (bytes.length > this.o.maxBytes) {
      await this.fail(item, 'too_large', false);
      return false;
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
    await this.o.db.rpc(bridgesWorkerClaims(), 'internal.bridge_media_attach',
      [item.messageId, item.idx, storagePath, bytes.length, sha256, frame.mime ?? item.mime]);
    return true;
  }

  private async fail(item: DueMedia, reason: string, retry: boolean): Promise<void> {
    await this.o.db.rpc(bridgesWorkerClaims(), 'internal.bridge_media_fail', [item.messageId, item.idx, reason, retry])
      .catch((err) => this.o.log?.(`[bridges] media fail record failed: ${(err as Error).message}`));
  }
}
