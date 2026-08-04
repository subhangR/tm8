/**
 * T3-4 / T3-5 — THE PURE MODEL. Everything on these two screens that is a
 * derivation rather than a render lives here, so it can be tested without a
 * DOM and so no component recomputes it a second, slightly different way.
 *
 * The oracle's own words are the specification for two of these functions:
 *
 *   L94: "one chip everywhere — glyph by type (▦ image · ❐ pdf · ▤ text ·
 *        ◇ other); sourceMissing is wait amber, not an error"
 *   L124: "Three failure words: failed (upload, block red, retryable) ·
 *        missing from this node (wait amber — the record exists, the bytes
 *        don't) · no preview (neutral — download works). Never a generic
 *        'error'."
 *
 * Those two sentences are laws, not decoration: the glyph set is closed, and
 * the failure vocabulary is closed. `failureWord()` below returns one of
 * exactly three strings and has no default branch that could invent a fourth.
 */
import type { EntityDetail, EntitySummary, FileAttachment, MessageView } from '@tm8/contract';

// ---------------------------------------------------------------------------
// File type → glyph, preview capability
// ---------------------------------------------------------------------------

/** The oracle's closed glyph set (L94). Four members, no fifth. */
export type FileGlyph = '▦' | '❐' | '▤' | '◇';

/**
 * What a preview surface can actually SHOW. This is about the file's type
 * only — whether the BYTES are reachable is a separate question the port
 * answers, and conflating the two is how "no preview for .mov" would end up
 * shown for a png whose download link merely wasn't wired.
 */
export type PreviewKind = 'image' | 'pdf' | 'text' | 'none';

export function previewKindOf(mime: string): PreviewKind {
  const m = mime.toLowerCase().trim();
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('text/')) return 'text';
  // The text family is wider than `text/*`: these are read as text everywhere
  // else in this app, and calling a .md file "unpreviewable" would be false.
  if (m === 'application/json' || m === 'application/xml' || m === 'application/x-yaml') return 'text';
  return 'none';
}

export function glyphFor(mime: string): FileGlyph {
  switch (previewKindOf(mime)) {
    case 'image':
      return '▦';
    case 'pdf':
      return '❐';
    case 'text':
      return '▤';
    case 'none':
      return '◇';
  }
}

/**
 * The extension the "No preview for .mov" copy names. Derived from the NAME,
 * not the mime, because that is what the oracle prints (L112) and what the
 * user recognises. Returns null when the name has no extension — the copy
 * then falls back to the mime, never to a bare "this file".
 */
export function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot).toLowerCase();
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/**
 * Two size voices, both drawn by the oracle, deliberately kept apart:
 *   · the CHIP voice — "1.2M", "340K" (L76/L77), no space, single letter;
 *   · the ROW voice   — "1.2 MB", "41 MB" (L50/L60), spaced, two letters.
 * They are not interchangeable; a chip is a token in a sentence and a row is
 * a table cell.
 */
export function formatSizeChip(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${round1(bytes / (1024 * 1024))}M`;
}

export function formatSizeRow(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${round1(bytes / (1024 * 1024))} MB`;
  return `${round1(bytes / (1024 * 1024 * 1024))} GB`;
}

function round1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? `${r}` : r.toFixed(1);
}

// ---------------------------------------------------------------------------
// The three failure words (oracle L124) — a CLOSED vocabulary
// ---------------------------------------------------------------------------

export type FileFailure = 'failed' | 'missing' | 'no-preview';

/**
 * The exact words, and the exact tone each carries. `missing` is WAIT amber
 * and not block red on purpose: the record exists and the bytes do not, which
 * is a state that can resolve itself. Styling it red would tell the user
 * something broke.
 */
export function failureWord(failure: FileFailure): { word: string; tone: 'block' | 'wait' | 'idle' } {
  switch (failure) {
    case 'failed':
      return { word: 'failed', tone: 'block' };
    case 'missing':
      return { word: 'missing from this node', tone: 'wait' };
    case 'no-preview':
      return { word: 'no preview', tone: 'idle' };
  }
}

// ---------------------------------------------------------------------------
// The row a file renders as, wherever it renders
// ---------------------------------------------------------------------------

/**
 * ONE row shape for every file surface on this screen — the queue, the chips,
 * the FILES·N section, the preview. The oracle's first sentence about this
 * frame (L24) is "files are attachments on entities and messages, never a
 * kind of their own — one chip grammar everywhere", and one grammar in the
 * drawing is one type in the code.
 *
 * `sizeBytes: null` is a real absence, not zero: a message attachment
 * (`FileAttachment`) carries `{fileEntityId, name, mime}` and NO size, so a
 * chip built from one has nothing to print. Rendering "0B" there would be the
 * D7.2 lie in miniature.
 */
export interface FileRow {
  fileEntityId: string;
  name: string;
  mime: string;
  sizeBytes: number | null;
  /**
   * The `attached_to` edge this row was READ THROUGH, when it was read through
   * one — the only handle `edges.delete` accepts, and therefore the only thing
   * that makes a row detachable.
   *
   * `null` is the common and correct case, not a hole: a row built from a file
   * ENTITY (the files gallery) or from a MESSAGE attachment was not reached by
   * an edge at all, so there is no link to cut and the strip draws no detach
   * control for it. Defaulting this to some edge would offer to remove
   * something the user is not looking at.
   */
  edgeId: string | null;
  /**
   * Who attached it and when — the oracle's "340K · @ada · 2m" meta (L84).
   * The ACTOR is carried whole, not flattened to a name, because L125 makes
   * provenance visible: "a session's uploads use the same chips with agent
   * provenance — square avatar in the meta, nothing visually second-class".
   * `kit/Avatar` already encodes that law (round human / rounded-square
   * agent), so the row only has to keep the flag.
   */
  attributedTo: { displayName: string; isAgent: boolean } | null;
  attributedAt: string | null;
  /**
   * The bytes are known-absent on this node. NOTHING in the contract reports
   * this per file today (`sourceMissing` exists only on `HandoffView`), so
   * every real row arrives `false` and the state is reachable only from
   * specimen data. Recorded in HANDOVER §GAPS rather than quietly dropped —
   * the oracle draws the state and the vocabulary for it is settled, so the
   * renderer is ready the day a field appears.
   */
  sourceMissing: boolean;
}

/** A file entity's own state, read through the contract's discriminated union. */
export function rowFromEntity(entity: EntitySummary): FileRow | null {
  const state = entity.state;
  // Structural, not a kind literal: the `file` member of CoreEntityState is
  // the only one carrying all three of name/mimeType/sizeBytes.
  if (
    !('name' in state) ||
    !('mimeType' in state) ||
    !('sizeBytes' in state) ||
    typeof state.name !== 'string' ||
    typeof state.mimeType !== 'string' ||
    typeof state.sizeBytes !== 'number'
  ) {
    return null;
  }
  return {
    fileEntityId: entity.id,
    name: state.name,
    mime: state.mimeType,
    sizeBytes: state.sizeBytes,
    attributedTo: { displayName: entity.createdBy.displayName, isAgent: entity.createdBy.isAgent },
    attributedAt: entity.createdAt,
    sourceMissing: false,
    edgeId: null,
  };
}

/**
 * A message attachment. Size is genuinely unknown here — see `FileRow` — and
 * the caller may enrich it from the file entity if it has one in hand, which
 * `enrich()` below does without inventing anything.
 */
export function rowFromAttachment(
  attachment: FileAttachment,
  message: Pick<MessageView, 'state' | 'createdAt'>,
): FileRow {
  return {
    fileEntityId: attachment.fileEntityId,
    name: attachment.name,
    mime: attachment.mime,
    sizeBytes: null,
    attributedTo: {
      displayName: message.state.author.displayName,
      isAgent: message.state.author.isAgent,
    },
    attributedAt: message.createdAt,
    sourceMissing: false,
    edgeId: null,
  };
}

/**
 * Fills a row's null size from a file entity the caller already has. Never
 * overwrites a value that is present, and never fabricates one that is not —
 * an unmatched row stays null-sized and the chip prints no size at all, which
 * is the honest form of "we don't know how big this is".
 */
export function enrich(rows: readonly FileRow[], entities: readonly EntitySummary[]): FileRow[] {
  const byId = new Map<string, FileRow>();
  for (const entity of entities) {
    const row = rowFromEntity(entity);
    if (row) byId.set(row.fileEntityId, row);
  }
  return rows.map((row) => {
    if (row.sizeBytes !== null) return row;
    const known = byId.get(row.fileEntityId);
    return known ? { ...row, sizeBytes: known.sizeBytes } : row;
  });
}

/**
 * Files attached to an entity, from its `connections`.
 *
 * THE EDGE TYPE IS `attached_to` — contract `contract.ts:1173` ("Finalized
 * `file -> attached_to -> target` edges created atomically") and
 * `CreateEntityInput.attachTo.edgeType`. An edge TYPE is not an entity KIND,
 * so naming it here is not a §15.2 literal; the kind is never named, and a
 * peer that does not carry file state is dropped by `rowFromEntity` rather
 * than by a kind check.
 */
export const ATTACHED_TO = 'attached_to';

export function attachedFiles(detail: EntityDetail): FileRow[] {
  const groups = [...detail.connections.incoming, ...detail.connections.outgoing];
  const rows: FileRow[] = [];
  for (const group of groups) {
    if (group.type !== ATTACHED_TO) continue;
    for (const edge of group.edges) {
      // The file is the peer, whichever end of the edge it sits on. Trying
      // both and keeping what parses is what makes this direction-agnostic
      // without a second branch on `group.direction`.
      const peer = rowFromEntity(edge.source) ?? rowFromEntity(edge.target);
      // The edge id rides along HERE and only here — this is the one path that
      // reached the file through a link, so it is the one path that can cut it.
      const row = peer === null ? null : { ...peer, edgeId: edge.id };
      if (row && !rows.some((r) => r.fileEntityId === row.fileEntityId)) rows.push(row);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The upload queue (oracle L38–L65)
// ---------------------------------------------------------------------------

/**
 * The three queue states the oracle draws. This type exists even though NO
 * upload can be started by this standalone Files card without a host-supplied
 * task. The states are contract-real (`FileUploadGrant` → PUT →
 * `uploadComplete`, with `payload_too_large` above the grant's
 * `maxSizeBytes`) and are live in the Chat composer.
 */
export type UploadItem =
  | { phase: 'uploading'; name: string; mime: string; percent: number }
  | { phase: 'uploaded'; name: string; mime: string; sizeBytes: number }
  | { phase: 'failed'; name: string; mime: string; sizeBytes: number | null; why: string };

/**
 * The cap sentence under the dropzone. The oracle prints "25 MB per file"
 * (L36) as a literal; the contract says the ceiling is deployment-configurable
 * (`FILE_MAX_SIZE_BYTES_DEFAULT`, 512 MB) and that GRANTS CARRY THE EFFECTIVE
 * VALUE — i.e. the real number is only knowable from a grant, and no grant can
 * be obtained in this build.
 *
 * So this returns null when no cap has been measured, and the dropzone prints
 * the hollow form instead of either number. Printing 25 would transcribe a
 * specimen; printing 512 would assert a default this deployment may not use.
 */
export function capSentence(maxSizeBytes: number | null): string | null {
  if (maxSizeBytes === null) return null;
  return `${formatSizeRow(maxSizeBytes)} per file`;
}
