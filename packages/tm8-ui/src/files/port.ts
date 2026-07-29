/**
 * THE FILES / NODE PORT — the only place this module knows a seam exists.
 *
 * Same law as `settings-space/port.ts` and `views/useGateData.ts`: the
 * components below take plain values and callbacks and cannot tell a fixture
 * from a real node. The coordinator wires `filesPortFromSeam(seam, spaceId)`
 * and `nodePortFromSeam(seam, spaceId)` in the host; nothing in `files/`
 * imports a seam implementation.
 *
 * READS ONLY, and — as in settings-space — that is the finding, not an
 * omission. Every read here works against a real seam. Every WRITE these two
 * screens draw (upload, retry, cancel, attach, detach, provider add, provider
 * test, backup, restore) has no executor in `seam.commands`; they live in
 * `reasons.ts` as disabled-with-reason, and this port deliberately exposes no
 * method for them so a future component cannot quietly acquire one.
 *
 * The port is driven against an ACTUAL `createFixtureSeam()` in
 * `port-seam.test.tsx`, asserting on what comes BACK rather than on what was
 * called — the brief's four-links lesson: declaration → data → implementation
 * → CALL can each be green while the feature is dead.
 */
import type { EntityId, MessageView, SpaceId } from '@tm8/contract';
import type { ConnectionState, LivenessSnapshot, Seam, Unsubscribe } from '../data/seam';
import { allKinds } from '../domain';
import { attachedFiles, enrich, rowFromAttachment, rowFromEntity, type FileRow } from './model';

// ---------------------------------------------------------------------------
// The file kind, reached through REGISTRY DATA rather than typed
// ---------------------------------------------------------------------------

/**
 * §15.2 makes a kind string literal outside `domain/` and `fixtures/` a build
 * failure, and this lane carries its own copy of that guard
 * (`no-kind-literals.test.ts`). So `kinds: ['file']` is not available to me
 * even though it is exactly what a files query means.
 *
 * The registry answers better anyway: exactly one row asks its detail panel
 * for a `file-preview` block, and "the kind whose panel previews a file" is
 * precisely the kind a files collection lists. If a second such row ever
 * appears this THROWS rather than silently picking one — a wrong-but-plausible
 * file list is worse than a loud failure. (The shape is lifted from
 * `settings-space/port.ts`'s `memberKindRef`, which solves the same problem
 * for members.)
 */
export function fileKindRef(): string {
  const rows = allKinds().filter((row) =>
    (row.panel.blocks ?? []).some((block) => block.block === 'file-preview'),
  );
  if (rows.length !== 1) {
    throw new Error(
      `files: expected exactly one registry row whose panel carries a file-preview block, found ${rows.length}`,
    );
  }
  return rows[0]!.kind;
}

// ---------------------------------------------------------------------------
// T3-4 — the files port
// ---------------------------------------------------------------------------

export interface MessageWithFiles {
  message: MessageView;
  files: FileRow[];
}

export interface FilesPort {
  /**
   * Every file entity in the space. Real: one `seam.query` on the registry's
   * file kind. Used by the specimen board and by any host that wants a
   * gallery; the SCREEN itself never needs it, because "files are attachments
   * on entities and messages, never a kind of their own" (oracle L24).
   */
  listFiles(): Promise<FileRow[]>;
  /**
   * The attachment chips on a thread. Real: `seam.messages(anchorId)` →
   * `MessageView.content.attachments`, which is contract-typed
   * (`FileAttachment[]`). Sizes are absent on an attachment and are filled in
   * from the file entities when a matching one exists — never invented.
   */
  messagesWithFiles(anchorId: EntityId): Promise<MessageWithFiles[]>;
  /**
   * The FILES · N section on an entity. Real: `seam.entity(id)` →
   * `connections`, filtered to `attached_to` edges.
   */
  filesOn(entityId: EntityId): Promise<FileRow[]>;
}

export function filesPortFromSeam(seam: Seam, spaceId: SpaceId): FilesPort {
  async function fileEntities() {
    const result = await seam.query({ spaceId, kinds: [fileKindRef() as never] });
    return result.page.items;
  }

  return {
    async listFiles() {
      const items = await fileEntities();
      return items.map(rowFromEntity).filter((row): row is FileRow => row !== null);
    },

    async messagesWithFiles(anchorId) {
      const page = await seam.messages(anchorId);
      const withAttachments = page.items.filter((m) => m.content.attachments.length > 0);
      if (withAttachments.length === 0) return [];
      // ONE extra read for the whole thread, not one per attachment: sizes are
      // a nicety and must not turn a thread render into N round-trips.
      const entities = await fileEntities();
      return withAttachments.map((message) => ({
        message,
        files: enrich(
          message.content.attachments.map((a) => rowFromAttachment(a, message)),
          entities,
        ),
      }));
    },

    async filesOn(entityId) {
      const detail = await seam.entity(entityId);
      return attachedFiles(detail);
    },
  };
}

// ---------------------------------------------------------------------------
// T3-5 — the node port
// ---------------------------------------------------------------------------

/**
 * THE HONEST NODE FACTS — everything on the machine-room screen that this
 * build can actually measure. It is a short list, and its shortness IS the
 * screen's content.
 *
 * `null` means NOT MEASURED and renders as a dash with a caption (T1-4 /
 * D7.2). It never renders as `0`, because "we looked and found none" and
 * "nothing ever looked" are different facts and only one of them is true here.
 */
export interface NodeFacts {
  /** Reachability, from the seam's own connection honesty states. */
  connection: ConnectionState;
  /** Live sessions on this node, from the liveness snapshot. A REAL zero. */
  liveSessionCount: number | null;
  /** Stable per node process; rotates on restart (contract.ts:1103). */
  nodeBootId: string | null;
  /** When the liveness snapshot was taken — the measurement's timestamp. */
  checkedAt: string | null;
  /**
   * The concurrency ceiling. ALWAYS null in this build: the contract has a
   * `capacity` refusal code for hitting it and no operation that reports it.
   */
  slotCap: number | null;
}

export interface NodePort {
  /** Current facts, synchronously — safe to call during render. */
  facts(): NodeFacts;
  /** Fires whenever connection state or the liveness snapshot changes. */
  subscribe(cb: (facts: NodeFacts) => void): Unsubscribe;
  /** Force a fresh liveness read. The only "act" this screen can perform. */
  refresh(): Promise<void>;
}

export function nodePortFromSeam(seam: Seam, spaceId: SpaceId): NodePort {
  let snapshot: LivenessSnapshot | null = null;

  const facts = (): NodeFacts => ({
    connection: seam.getConnection(),
    liveSessionCount: snapshot ? snapshot.liveEntityIds.length : null,
    nodeBootId: snapshot?.nodeBootId ?? null,
    checkedAt: snapshot?.checkedAt ?? null,
    slotCap: null,
  });

  return {
    facts,
    subscribe(cb) {
      const offConnection = seam.onConnection(() => cb(facts()));
      const offLiveness = seam.liveness.onChange((snap) => {
        if (snap.spaceId !== spaceId) return;
        snapshot = snap;
        cb(facts());
      });
      return () => {
        offConnection();
        offLiveness();
      };
    },
    async refresh() {
      snapshot = await seam.liveness.refresh(spaceId);
    },
  };
}

/**
 * A port over facts a HOST already has — the specimen board's path, and the
 * escape hatch for a host that holds a liveness snapshot already and does not
 * want a second subscription. Deliberately not a second seam call site.
 */
export function staticNodePort(facts: NodeFacts): NodePort {
  return {
    facts: () => facts,
    subscribe: () => () => {},
    refresh: async () => {},
  };
}
