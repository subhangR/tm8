/**
 * THE FILES / NODE PORT — the only place this module knows a seam exists.
 *
 * Same law as `settings-space/port.ts` and `views/useGateData.ts`: the
 * components below take plain values and callbacks and cannot tell a fixture
 * from a real node. The coordinator wires `filesPortFromSeam(seam, spaceId)`
 * and `nodePortFromSeam(seam, spaceId)` in the host; nothing in `files/`
 * imports a seam implementation.
 *
 * READS ONLY for the two SCREENS, and — as in settings-space — that is the
 * finding, not an omission. Every read here works against a real seam. The
 * writes those two screens draw (retry, provider add, provider test, backup,
 * restore) still have no executor in `seam.commands`; they live in
 * `reasons.ts` as disabled-with-reason, and this port deliberately exposes no
 * method for them so a future component cannot quietly acquire one.
 *
 * THE ONE EXCEPTION, added 2026-08-01 with its own port: `attachmentsPort`.
 * Upload was never a capability gap — the canonical grant lifecycle has been
 * live in `seam.files` and used by the chat composer all along; what was
 * missing was a HOST willing to hand it to a second surface. Download was a
 * genuine seam gap and is now closed by seam Amendment 3 (`files.downloadHref`).
 * Both are therefore reachable, and refusing them would now be the dishonest
 * render. `reasons.ts` keeps its entries for the standalone specimen card,
 * which still receives no dispatcher.
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
import { createFileUploadTask, type FileUploadTask } from './upload';

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
// The attachment port — what an ENTITY PANEL needs to show and add files
// ---------------------------------------------------------------------------

/**
 * Three verbs and nothing else, because the strip does three things: resolve
 * bytes for a file it already knows about, start an upload against an anchor,
 * and cut a link it has already drawn. The already-attached ROWS are not here
 * — they come off the anchor's own `EntityDetail.connections` via
 * `attachedFiles()`, which the panel already holds, so putting a read here
 * would add a round-trip for data in hand.
 */
export interface AttachmentsPort {
  /** Seam Amendment 3. Never null in this port: the seam always answers. */
  downloadHref(fileEntityId: string): string;
  startUpload(file: File, anchorId: EntityId): FileUploadTask;
  /**
   * Seam Amendment 5. Deletes the `attached_to` EDGE, never the file: the same
   * bytes may hang off three other entities, and "remove from this task" must
   * not mean "destroy for everyone". Resolves when the link is gone; the host
   * refetches the anchor from there.
   */
  detach(edgeId: string): Promise<void>;
}

export function attachmentsPortFromSeam(seam: Seam, spaceId: SpaceId | string): AttachmentsPort {
  return {
    downloadHref: (fileEntityId) => seam.files.downloadHref(fileEntityId as EntityId),
    startUpload: (file, anchorId) =>
      createFileUploadTask({ files: seam.files, file, spaceId, anchorId }),
    /**
     * The mutation id is minted HERE because the server requires one and the
     * strip has no journal to reconcile against — the same choice the row
     * lifecycle makes for delete/restore.
     */
    detach: async (edgeId) => {
      await seam.commands.deleteEdge(edgeId, { clientMutationId: `detach:${edgeId}:${Date.now()}` });
    },
  };
}

/**
 * THE ONE CALL EVERY PANEL HOST MAKES — the `debugSurfaceFor` shape, for the
 * same reason it exists there.
 *
 * A host's seam is sometimes optional (`GraphScreen` takes one), and every host
 * that had to write its own `seam ? … : undefined` is a host that could write
 * it differently. Absent seam ⇒ absent port ⇒ the strip renders read-only and
 * draws no dropzone, which is the honest render for a screen that genuinely
 * cannot upload. `panel-host-wiring.test.ts` requires this function by name at
 * every mount site.
 */
export function attachmentsFor(
  seam: Seam | undefined,
  spaceId: SpaceId | string,
): AttachmentsPort | undefined {
  return seam ? attachmentsPortFromSeam(seam, spaceId) : undefined;
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
