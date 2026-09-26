/**
 * launch.preview — the launch card's "What the agent gets" dry run (launch
 * card v3, contract decision 6).
 *
 * The body is `execution.spawn`'s input minus `clientMutationId`, `cols` and
 * `rows`, field for field. The server runs spawn's OWN context load, manifest
 * composition and prompt budget on it — not a re-implementation — so the
 * preview is what the spawn would do. Nothing is written: no session row, no
 * derived task, no worktree, no PTY.
 *
 * A launch spawn would refuse still answers 200, with `refusal` set to the
 * code and `details.reason` spawn would give, so the card can say why before
 * the commit. Authorization refusals (not a member, a link bearer) and a
 * malformed body are errors, as on any read.
 */
import type { CommandErrorCode, EntityId, ExecutionSpawnInput } from './contract.js';

export type LaunchPreviewInput = Omit<ExecutionSpawnInput, 'clientMutationId' | 'cols' | 'rows'>;

/** The prompt sections a launch can carry, in render order. */
export const LAUNCH_PREVIEW_SECTION_KEYS = [
  'task',
  'in_full',
  'notes',
  'context_index',
  'attachments',
  'linked',
] as const;
export type LaunchPreviewSectionKey = (typeof LAUNCH_PREVIEW_SECTION_KEYS)[number];

export interface LaunchPreviewItem {
  id: EntityId;
  kind: string;
  /** Graph content: render it as plain text. */
  title: string;
  /** UTF-8 bytes this item adds to the prompt as rendered. */
  bytes: number;
}

export interface LaunchPreviewSection {
  key: LaunchPreviewSectionKey;
  /** UTF-8 bytes of the whole section as rendered, frame included. */
  bytes: number;
  /** What the section names, in render order (empty for `notes`). */
  items: LaunchPreviewItem[];
}

/**
 * Why a candidate is not in this launch. `unticked`: a default the selection
 * left out; `jev`: left out for a Jev reason (`selectionReasons`);
 * `duplicate`: listed once elsewhere (in full wins over the index and
 * `<linked>`).
 */
export type LaunchPreviewLeftOutReason = 'unticked' | 'jev' | 'duplicate';

export interface LaunchPreviewLeftOut {
  id: EntityId;
  kind: string;
  title: string;
  reason: LaunchPreviewLeftOutReason;
}

export interface LaunchPreviewRefusal {
  /** The error code spawn would answer with, e.g. `payload_too_large`. */
  code: CommandErrorCode;
  /** Spawn's `details.reason` (`in_full_budget`, `launch_total`, `in_full_kind_not_allowed`…); null when it gives none. */
  reason: string | null;
  details: Record<string, unknown>;
}

export interface LaunchPreviewResult {
  /** In render order; a section with nothing in it is omitted. */
  sections: LaunchPreviewSection[];
  /** The whole initial injection (system + task turn), in UTF-8 bytes. */
  totalBytes: number;
  /** As `LaunchDefaultsResult.launchCapBytes`. */
  launchCapBytes: number;
  /** The title row: the subject's `<task>` plus the in-full extras, against `inFullBudgetBytes`. */
  inFull: { budgetBytes: number; bytes: number };
  /** Index entries dropped to fit what the cap left, lowest-ranked first. */
  indexDropped: LaunchPreviewItem[];
  leftOut: LaunchPreviewLeftOut[];
  /** Set when spawn would refuse this launch; the sections are then what could be measured. */
  refusal: LaunchPreviewRefusal | null;
}
