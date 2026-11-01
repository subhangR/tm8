/**
 * The server's end of the connector runtime link (BRIDGE-ENTITY-DESIGN §2.5,
 * D35): the push socket each runtime holds at `/v2/ws?bridgeRuntime=<id>`,
 * the allowlist push (§2.3, D28), the outbox dispatch, and `connect` for the
 * link flow (B1b-5's `BridgeRuntimeLink`).
 *
 * WHAT DRIVES A PUSH. Nothing in TypeScript decides that an allowlist changed.
 * Migration 398 marks a connection dirty from the database itself (a trigger
 * on `bridges`, whatever path paused, resumed, removed or created one) and
 * `pg_notify`s `tm8_bridge_allowlist`. The hub LISTENs when it can, and polls
 * every second regardless, so a notify lost to a reconnect costs at most a
 * second (§7.3 item 12 asks for 5). Every frame it sends carries a version the
 * database just bumped (D35), so versions only grow, across restarts too.
 *
 * ATTACHMENTS (431). A send row's frame comes with a server-only `files` list:
 * where each attached file's bytes are. The database cannot read blobs, so the
 * hub reads the first one that it can, sends it as `media` with the text as its
 * caption, and strips `files`. Any further attachment is named in the caption,
 * because one outbox row settles one WhatsApp message.
 *
 * WHAT IT NEVER DOES. It holds no queue of its own: an outbox row is taken
 * (`dispatching`) only while its runtime's socket is open, and a row a dead
 * socket swallowed returns to retry through the watchdog after two minutes.
 */
import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { CollabError } from '@tm8/contract';
import type { AllowlistFrame, ConversationsFrame, GroupFrame, GroupMembersFrame, MediaFrame, ServerFrame } from '@tm8/contract';

import type { Db, DbClaims } from '../../db/types.js';
import type { W2BlobStore } from '../../files/w2-blob-store.js';
import { createWsServer, type WsServer } from '../../events/ws-server.js';
import type { EventSink } from '../../events/ws-connection.js';
import type { RequestIdentity } from '../../http/types.js';
import { bridgesWorkerClaims } from '../outbox.js';

export interface BridgeRuntimeConnectInput {
  readonly provider: 'whatsapp';
  readonly connectionId: string;
  readonly authFlow?: { kind: 'qr' } | { kind: 'pairing'; phone: string };
}

/** `LISTEN` on one channel; resolves to an unsubscribe. Absent = poll only. */
export type BridgeNotifyListener = (channel: string, onNotify: () => void) => Promise<() => Promise<void>>;

export interface BridgeRuntimeHubOptions {
  readonly db: Db;
  /** The node key (32 bytes) every connection's stateKey derives from (D38). */
  readonly nodeKey: () => Promise<Buffer>;
  /** Resolves the push socket's caller; must admit `bridge_runtime` only for this path. */
  readonly authorize: (req: IncomingMessage) => Promise<RequestIdentity>;
  readonly listen?: BridgeNotifyListener;
  readonly log?: (line: string) => void;
  /** Poll period for allowlists and the outbox. Default 1000 ms. */
  readonly pollMs?: number;
  /** Where attachment bytes are read for outbound `media` (431). Absent: attachments are named in the text only. */
  readonly blobStore?: Pick<W2BlobStore, 'read'>;
}

/** 431: one attached file as `internal.bridge_outbox_take` describes it. Never sent to a runtime. */
export interface OutboundFile {
  fileEntityId: string;
  spaceId: string;
  storagePath: string;
  name: string;
  mime: string;
  size: number | string;
}

type SendFrame = Extract<ServerFrame, { type: 'send' }>;

/** What WhatsApp shows inline as an image; anything else goes as a document (Phase-1's IMAGE_MIMES). */
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** WhatsApp's ceilings: 16 MB for an image message, 100 MB for a document. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

interface RuntimeLink {
  readonly runtimeId: string;
  readonly sink: EventSink;
  provider: string | null;
  protocolVersion?: number;
}

interface Pending {
  resolve(value: unknown): void;
  timer: NodeJS.Timeout;
}

const RUNTIME_ID = /^[A-Za-z0-9._:-]{1,200}$/;

/** Is this upgrade the connector runtime's push socket? */
export function isBridgeRuntimeUpgrade(req: IncomingMessage): boolean {
  return new URL(req.url ?? '/', 'http://tm8.invalid').searchParams.has('bridgeRuntime');
}

/**
 * The 32-byte key a connection's sealed key directory is opened with (D38):
 * derived, never stored. The same node key and connection id always give the
 * same key, so a restarted server opens what the runtime wrote before.
 */
export function bridgeStateKey(nodeKey: Buffer, connectionId: string): string {
  return createHmac('sha256', nodeKey).update(`tm8.bridge-state.v1:${connectionId}`).digest('base64');
}

export class BridgeRuntimeHub {
  private readonly runtimes = new Map<string, RuntimeLink>();
  private readonly pending = new Map<string, Pending>();
  private readonly ws: WsServer;
  private readonly upgrading = new WeakMap<RequestIdentity, string>();
  private timer: NodeJS.Timeout | null = null;
  private unlisten: (() => Promise<void>) | null = null;
  private pumping = false;
  private again = false;

  constructor(private readonly o: BridgeRuntimeHubOptions) {
    this.ws = createWsServer({
      authorize: async (req) => {
        const identity = await o.authorize(req);
        if (identity.authKind !== 'bridge_runtime') {
          throw new CollabError('forbidden', 'the bridge runtime socket admits only the bridge runtime');
        }
        const runtimeId = new URL(req.url ?? '/', 'http://tm8.invalid').searchParams.get('bridgeRuntime') ?? '';
        if (!RUNTIME_ID.test(runtimeId)) throw new CollabError('invalid_input', 'bad bridgeRuntime id');
        this.upgrading.set(identity, runtimeId);
        return identity;
      },
      // A runtime may be quiet for a long time; it reconnects and says hello again.
      connection: { idleTimeoutMs: 24 * 60 * 60_000, absoluteTimeoutMs: 7 * 24 * 60 * 60_000 },
      onConnection: (sink) => {
        const runtimeId = this.upgrading.get(sink.identity);
        if (!runtimeId) return sink.close(1008, 'unidentified runtime');
        this.runtimes.get(runtimeId)?.sink.close(1000, 'replaced by a newer socket');
        this.runtimes.set(runtimeId, { runtimeId, sink, provider: null });
        // Nothing a runtime sends on this socket is read: its frames are POSTs.
        sink.onClose(() => {
          if (this.runtimes.get(runtimeId)?.sink === sink) this.runtimes.delete(runtimeId);
        });
        this.kick();
      },
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    return this.ws.handleUpgrade(req, socket, head);
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), this.o.pollMs ?? 1000);
    this.timer.unref();
    if (this.o.listen) {
      try {
        this.unlisten = await this.o.listen('tm8_bridge_allowlist', () => this.kick());
      } catch (err) {
        this.o.log?.(`[bridges] LISTEN failed, polling only: ${(err as Error).message}`);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.unlisten?.().catch(() => {});
    this.unlisten = null;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.ws.closeAll();
  }

  /** The runtime ids with an open push socket. */
  connectedRuntimes(): string[] {
    return [...this.runtimes.keys()];
  }

  /** Called by the `hello` door: which provider this runtime speaks for. */
  noteHello(runtimeId: string, provider: string, protocolVersion = 1): void {
    const link = this.runtimes.get(runtimeId);
    if (link) { link.provider = provider; link.protocolVersion = protocolVersion; }
    this.kick();
  }

  async stateKey(connectionId: string): Promise<string> {
    return bridgeStateKey(await this.o.nodeKey(), connectionId);
  }

  /** B1b-5's `BridgeRuntimeLink.connect`: start or re-link one connection on its provider's runtime. */
  /**
   * `claims` are the begin caller's OWN (422): bridge_runtime_connect admits
   * the connection's human owner or the bridges worker, so a member request
   * never binds the worker's backgroundJob claim.
   */
  async connect(input: BridgeRuntimeConnectInput, claims: DbClaims): Promise<{ runtimeId: string } | null> {
    const link = [...this.runtimes.values()].find((r) => r.provider === input.provider)
      ?? (this.runtimes.size === 1 ? [...this.runtimes.values()][0] : undefined);
    if (!link) return null;
    const bound = await this.o.db.rpc<{ allowlist: AllowlistFrame }>(claims, 'internal.bridge_runtime_connect',
      [input.connectionId, link.runtimeId]);
    this.send(link.runtimeId, {
      type: 'connect',
      connectionId: input.connectionId,
      stateKey: await this.stateKey(input.connectionId),
      ...(input.authFlow ? { authFlow: input.authFlow } : {}),
      allowlist: bound.allowlist,
    });
    return { runtimeId: link.runtimeId };
  }

  /**
   * B1b-7 (`bridges.connections.remove`): stop one connection on the runtime
   * holding it; `logout` unlinks the device and wipes its sealed keys (D38).
   * Sent to `runtimeId` when that runtime is connected, else to every open
   * runtime (a runtime ignores a connection it does not hold). Each send stands
   * alone, so a socket closing mid-loop costs only itself: true exactly when at
   * least one runtime got the frame.
   */
  async disconnect(connectionId: string, opts: { logout: boolean; runtimeId?: string | null }): Promise<boolean> {
    const held = opts.runtimeId ? this.runtimes.get(opts.runtimeId) : undefined;
    const targets = held && held.sink.isOpen ? [held] : [...this.runtimes.values()].filter((r) => r.sink.isOpen);
    let sent = 0;
    for (const link of targets) {
      try {
        this.send(link.runtimeId, { type: 'disconnect', connectionId, ...(opts.logout ? { logout: true } : {}) });
        sent += 1;
      } catch (err) {
        this.o.log?.(`[bridges] disconnect to runtime ${link.runtimeId} failed: ${(err as Error).message}`);
      }
    }
    // A removed connection gets no further allowlist (bridge_allowlists_due skips it): the
    // disconnect itself stops it on the runtime, and the next hello reply leaves it out.
    // The kick still pushes any other connection this change left due.
    this.kick();
    return sent > 0;
  }

  /** The owner's live group list (§4.3 picker, D28): asked of the runtime, never stored. */
  async listConversations(runtimeId: string, connectionId: string, requestId: string, timeoutMs = 15_000): Promise<ConversationsFrame> {
    return this.request(runtimeId, requestId, { type: 'conversation.list', requestId, connectionId }, timeoutMs) as Promise<ConversationsFrame>;
  }

  async fetchMedia(runtimeId: string, input: { requestId: string; connectionId: string; conversationId: string; handle: string; maxBytes: number },
    timeoutMs = 60_000): Promise<MediaFrame> {
    return this.request(runtimeId, input.requestId, { type: 'media.fetch', ...input }, timeoutMs) as Promise<MediaFrame>;
  }

  /** 426: make a group on the number (the bridge's /split). WhatsApp can take a while to answer. */
  async createGroup(runtimeId: string, input: { requestId: string; connectionId: string; subject: string; participants: string[]; sourceConversationId?: string },
    timeoutMs = 30_000): Promise<GroupFrame> {
    if (input.sourceConversationId && (this.runtimes.get(runtimeId)?.protocolVersion ?? 1) < 2) {
      return { requestId: input.requestId, connectionId: input.connectionId,
        error: 'Cannot split until the WhatsApp runtime is upgraded to support community groups', code: 'community_create_failed' };
    }
    try {
      return await this.request(runtimeId, input.requestId, { type: 'group.create', ...input }, timeoutMs) as GroupFrame;
    } catch (error) {
      if (!input.sourceConversationId) throw error;
      // A lost answer can follow successful creation. Do not automatically create a second group on retry.
      return { requestId: input.requestId, connectionId: input.connectionId, code: 'community_create_failed',
        error: "Can't split: the WhatsApp runtime did not confirm creating the group. Check WhatsApp before trying again; a group may have been created." };
    }
  }

  async groupMembers(runtimeId: string, input: { requestId: string; connectionId: string; conversationId: string },
    timeoutMs = 15_000): Promise<GroupMembersFrame> {
    if ((this.runtimes.get(runtimeId)?.protocolVersion ?? 1) < 3) {
      return { requestId: input.requestId, connectionId: input.connectionId,
        error: 'Upgrade the WhatsApp runtime before resolving group member identities' };
    }
    return this.request(runtimeId, input.requestId, { type: 'group.members', ...input }, timeoutMs) as Promise<GroupMembersFrame>;
  }

  /** 426: add people to a connected group (the bridge's /invite). */
  async addToGroup(runtimeId: string, input: { requestId: string; connectionId: string; conversationId: string; participants: string[] },
    timeoutMs = 30_000): Promise<GroupFrame> {
    return this.request(runtimeId, input.requestId, { type: 'group.add', ...input }, timeoutMs) as Promise<GroupFrame>;
  }

  /** The `conversations`, `media` and `group` doors answer a request this hub made. */
  settleRequest(requestId: string, frame: unknown): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(frame);
    return true;
  }

  private request(runtimeId: string, requestId: string, frame: ServerFrame, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CollabError('upstream_unavailable', 'the bridge runtime did not answer in time'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, timer });
      try {
        this.send(runtimeId, frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err);
      }
    });
  }

  private send(runtimeId: string, frame: ServerFrame): void {
    const link = this.runtimes.get(runtimeId);
    if (!link || !link.sink.isOpen) throw new CollabError('upstream_unavailable', 'the bridge runtime is not connected');
    link.sink.send(JSON.stringify(frame));
  }

  /** Coalesced: a pump in flight runs once more when it finishes. */
  kick(): void {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    void this.pump()
      .catch((err) => this.o.log?.(`[bridges] hub pump failed: ${(err as Error).message}`))
      .finally(() => {
        this.pumping = false;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }

  private async pump(): Promise<void> {
    const ids = this.connectedRuntimes();
    if (ids.length === 0) return;
    // Allowlists first: a pause must never queue behind a send (§7.3 item 12).
    const lists = await this.o.db.rpc<{ runtimeId: string; frame: AllowlistFrame }[]>(
      bridgesWorkerClaims(), 'internal.bridge_allowlists_due', [ids]);
    for (const { runtimeId, frame } of lists ?? []) {
      try {
        this.send(runtimeId, frame);
      } catch {
        // The socket closed mid-push: the runtime takes a fresh list in its next `hello`.
      }
    }
    const sends = await this.o.db.rpc<{ runtimeId: string; frame: ServerFrame }[]>(
      bridgesWorkerClaims(), 'internal.bridge_outbox_take', [ids, 50]);
    for (const { runtimeId, frame: raw } of sends ?? []) {
      const frame = raw.type === 'send' ? await this.withMedia(raw as SendFrame & { files?: OutboundFile[] | null }) : raw;
      try {
        this.send(runtimeId, frame);
      } catch {
        // Left `dispatching`; the watchdog returns it to retry after two minutes.
      }
    }
  }

  /**
   * 431: a send row's attachments become the frame's `media`. The first file
   * that can be read goes as the media message, captioned with the text; a file
   * that cannot be read or is too large for WhatsApp, and any further file, is
   * named in the caption instead, so nothing is dropped silently.
   */
  private async withMedia(frame: SendFrame & { files?: OutboundFile[] | null }): Promise<SendFrame> {
    const { files, ...out } = frame;
    if (!files || files.length === 0) return out;
    const notes: string[] = [];
    let media: SendFrame['media'];
    for (const file of files) {
      if (media) {
        notes.push(`[${file.name}: in tm8]`);
        continue;
      }
      const size = Number(file.size);
      const image = IMAGE_MIMES.has(file.mime) && size <= MAX_IMAGE_BYTES;
      if (!this.o.blobStore || size > MAX_DOCUMENT_BYTES) {
        notes.push(`[${file.name}: in tm8]`);
        continue;
      }
      try {
        const bytes = await this.o.blobStore.read(file.storagePath, file.spaceId);
        media = { kind: image ? 'image' : 'document', mime: file.mime, fileName: file.name, caption: '', data: bytes.toString('base64') };
      } catch (err) {
        this.o.log?.(`[bridges] outbox ${frame.outboxId}: could not read ${file.fileEntityId}: ${(err as Error).message}`);
        notes.push(`[${file.name}: in tm8]`);
      }
    }
    const text = [out.text ?? '', ...notes].filter((t) => t !== '').join('\n');
    if (!media) return { ...out, text };
    const sent: SendFrame = { ...out, media: { ...media, caption: text } };
    delete sent.text;
    return sent;
  }
}
