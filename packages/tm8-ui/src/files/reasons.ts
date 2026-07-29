/**
 * THE GAP LEDGER, IN CODE — every act these two screens draw that this build
 * cannot perform, in one file, countable in one read.
 *
 * Precedent: `src/auth/reasons.ts` and `src/settings-space/reasons.ts`. The
 * shape exists because of the R5 finding it prevents: five dead verbs turned
 * out to be a CLASS, not five instances, and nobody could see that while the
 * refusals were spread across five components.
 *
 * EVERY entry below was checked against `src/data/seam.ts` and
 * `@tm8/contract` (contract.ts + catalog.ts) on 2026-07-29 — not remembered.
 * The distinction each entry preserves, because the two have completely
 * different remedies:
 *
 *   SEAM GAP     — the server route exists and is contract-`v1`; the UI seam
 *                  simply does not carry the verb. Remedy: a seam amendment.
 *   CAPABILITY   — nothing anywhere reports this. Remedy: build it, server
 *                  first. No amount of UI wiring reaches it.
 *
 * The node room is almost entirely the second kind, and that is the single
 * most important fact about this surface.
 */
import type { UnavailableReason } from '../panels';

function reason(cause: string, remedy: string): UnavailableReason {
  return { cause, remedy };
}

// ===========================================================================
// T3-4 — FILES & ATTACHMENTS
// ===========================================================================

/**
 * SEAM GAP. `catalog.ts:106-108` lists `files.uploadInit` (POST
 * /v2/files/uploads), `files.uploadComplete` and `files.uploadAbort`, all
 * `status: 'v1'`, and `contract.ts:1142-1176` defines every DTO the flow
 * needs. `seam.commands` carries 18 verbs and not one of them is a file verb.
 * So the whole upload card is built against a real, finished server feature
 * that the UI has no handle on.
 */
export const UPLOAD_UNAVAILABLE = reason(
  'Uploading has no executor in this build',
  'files.uploadInit / uploadComplete / uploadAbort are contract-v1 routes, but seam.commands carries no file verb — a seam amendment, not a missing server capability.',
);

export const UPLOAD_RETRY_UNAVAILABLE = reason(
  'Retrying an upload has no executor in this build',
  'a retry re-runs files.uploadInit, which this build cannot call. The failure and its cause stay on screen either way.',
);

export const UPLOAD_CANCEL_UNAVAILABLE = reason(
  'Cancelling an upload has no executor in this build',
  'files.uploadAbort releases the grant server-side; the seam exposes no way to reach it.',
);

/**
 * SEAM GAP, with a lane boundary on top. `files.download` (GET
 * /v2/files/:fileEntityId/download) is contract-`v1` (catalog.ts:109) and is
 * the one read that returns raw bytes rather than the JSON envelope. The seam
 * exposes no read for it.
 *
 * WHY THIS LANE DOES NOT SIMPLY EMIT AN `<a href="/v2/files/…">`: constructing
 * a transport URL is `src/data/**` work — a lane whose seat the user closed —
 * and same-origin luck is not a substitute for a seam. Instead the components
 * take an OPTIONAL `downloadHref` resolver from the host: supply one and every
 * download control on the screen becomes a real link; supply nothing and they
 * all carry this reason. See HANDOVER "Integration note".
 */
export const DOWNLOAD_UNAVAILABLE = reason(
  'Downloading has no executor in this build',
  'files.download is a contract-v1 route and the seam exposes no read for it. Pass a downloadHref resolver to enable every download control on this screen at once.',
);

/**
 * A byte read, not a URL. An image preview needs only a src (so it rides on
 * `downloadHref`); a TEXT preview needs the first N lines as a string, which
 * is a fetch-and-decode nothing in the seam performs.
 */
export const TEXT_PREVIEW_UNAVAILABLE = reason(
  'Text previews need a byte read this build cannot make',
  'the frame renders the first 200 lines; reaching them means fetching and decoding files.download, which no seam read performs.',
);

/** Same read, paged. Kept separate so the pdf card can say what it means. */
export const PDF_PREVIEW_UNAVAILABLE = reason(
  'PDF previews need a byte read this build cannot make',
  'the paged variant of the text frame reads the same files.download bytes — no seam read performs it.',
);

/**
 * SEAM GAP. `messages.attachments.add/remove` are catalog-v1
 * (catalog.ts:151-152) with DTOs at contract.ts:1189-1194. Not in
 * `seam.commands`. Attaching an EXISTING file to a message and detaching one
 * are both unreachable.
 */
export const ATTACH_UNAVAILABLE = reason(
  'Attaching to a message has no executor in this build',
  'messages.attachments.add is a contract-v1 route; seam.commands carries no attachment verb.',
);

export const DETACH_UNAVAILABLE = reason(
  'Removing an attachment has no executor in this build',
  'messages.attachments.remove is a contract-v1 route; seam.commands carries no attachment verb.',
);

// ===========================================================================
// T3-5 — NODE SETTINGS & STATUS
// ===========================================================================

/**
 * CAPABILITY, and the biggest single absence in this whole surface.
 *
 * MEASUREMENT, 2026-07-29: all 102 operations in `@tm8/contract`'s
 * `catalog.ts` were listed and grepped for node / health / backup / provider.
 * The only match is a COMMENT about a Phase-2 `bridge.fetchBlob` that must
 * answer an honest 501 until built. There is no uptime read, no rss, no
 * database size, no vacuum time, no ws client count, no agent-host state.
 *
 * The oracle header says "health payload already exists — this renders it".
 * That is a statement about the DESIGN's assumed world, and it is not true of
 * this contract today. Rather than transcribe "up 14d 6h" as a plausible
 * number, every unmeasured fact on this card renders hollow (T1-4 / D7.2).
 */
export const NODE_HEALTH_UNAVAILABLE = reason(
  'No node health read exists anywhere in this build',
  'all 102 contract operations were checked on 2026-07-29 — none reports uptime, memory, database size or agent-host state. Server capability, not a seam gap.',
);

/**
 * The two facts this screen CAN measure, stated as a positive so the card can
 * explain why some rows are live and others are dashes.
 */
export const NODE_MEASURABLE_NOTE =
  'Reachability and live-session count are measured from the seam (connection state + liveness snapshot). Everything dashed has no reader in this build.';

export const PROVIDER_TEST_UNAVAILABLE = reason(
  'Test launch has no executor in this build',
  'a provider probe would run a command on the node and report its exit code and stderr; no contract operation does this.',
);

export const PROVIDER_ADD_UNAVAILABLE = reason(
  'Adding a provider has no executor in this build',
  'agent command templates are node configuration and no contract operation reads or writes them.',
);

export const PROVIDER_LIST_UNAVAILABLE = reason(
  'No provider registry read exists',
  'the command templates below come from whatever the host supplies; with no source wired, the card states that rather than inventing providers.',
);

export const BACKUP_NOW_UNAVAILABLE = reason(
  'Backing up has no executor in this build',
  'no contract operation triggers or reports a backup. Server capability, not a seam gap.',
);

/**
 * The oracle calls Restore "a consent moment (T2-2 pattern): it states what
 * gets overwritten and demands the node name typed back" (L230). Refusing it
 * is doubly correct here — a destructive act with no executor must never
 * present a confirm dialog that leads nowhere.
 */
export const RESTORE_UNAVAILABLE = reason(
  'Restoring has no executor in this build',
  'restore overwrites this node’s data and is a typed-confirmation consent moment; no contract operation performs it, so the confirmation is not offered.',
);

export const CONCURRENCY_CAP_UNKNOWN =
  'no cap read exists — the contract has a `capacity` refusal code but no operation reports the ceiling';

export const FILE_CAP_UNKNOWN =
  'the per-file ceiling is deployment-configured and travels on an upload grant; no grant can be obtained in this build';

// ===========================================================================
// The audit list
// ===========================================================================

/**
 * Asserted non-empty and fully-formed by the suite, which also sweeps both
 * screens for any control promising an act without one of these attached.
 * A new refusal that skips this list fails that sweep.
 */
export const ALL_FILES_NODE_REASONS: readonly UnavailableReason[] = [
  UPLOAD_UNAVAILABLE,
  UPLOAD_RETRY_UNAVAILABLE,
  UPLOAD_CANCEL_UNAVAILABLE,
  DOWNLOAD_UNAVAILABLE,
  TEXT_PREVIEW_UNAVAILABLE,
  PDF_PREVIEW_UNAVAILABLE,
  ATTACH_UNAVAILABLE,
  DETACH_UNAVAILABLE,
  NODE_HEALTH_UNAVAILABLE,
  PROVIDER_TEST_UNAVAILABLE,
  PROVIDER_ADD_UNAVAILABLE,
  PROVIDER_LIST_UNAVAILABLE,
  BACKUP_NOW_UNAVAILABLE,
  RESTORE_UNAVAILABLE,
];

/**
 * The operations these screens draw and cannot reach, split by remedy. This
 * is the list the coordinator hands upward; it is data, not prose, so it can
 * be diffed when the seam grows.
 */
export const MISSING_FILE_OPS: readonly { op: string; kind: 'seam-gap' | 'capability' }[] = [
  { op: 'files.uploadInit', kind: 'seam-gap' },
  { op: 'files.uploadComplete', kind: 'seam-gap' },
  { op: 'files.uploadAbort', kind: 'seam-gap' },
  { op: 'files.download', kind: 'seam-gap' },
  { op: 'messages.attachments.add', kind: 'seam-gap' },
  { op: 'messages.attachments.remove', kind: 'seam-gap' },
  { op: 'node.health', kind: 'capability' },
  { op: 'node.providers.list', kind: 'capability' },
  { op: 'node.providers.test', kind: 'capability' },
  { op: 'node.providers.add', kind: 'capability' },
  { op: 'node.concurrency.cap', kind: 'capability' },
  { op: 'node.backup.run', kind: 'capability' },
  { op: 'node.backup.restore', kind: 'capability' },
];
