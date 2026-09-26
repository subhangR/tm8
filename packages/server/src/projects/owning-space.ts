/**
 * THE PICKER SEAM (plan 01a0d9eb W11, K13): which ONE space owns a folder.
 *
 * Since migration 234 a folder is granted to at most one space on any node
 * that is not loopback-only (decision 29).
 *
 * K13, as the owner answered it (form 01a0db32-d438): NOT a heuristic. Every
 * project is owned by the space the owner names for it in an explicit,
 * owner-confirmed mapping (project -> owning space). W11-migrate takes that
 * mapping as input and REFUSES any project it does not name — a folder is
 * never assigned by activity, by who holds `accounts.is_owner`, or by age.
 * Activity and ownership are reported beside each decision
 * (`OwningSpaceReportRow`), never consulted by it.
 */
export type OwningSpaceMapping = ReadonlyMap<string, string>;

export type OwningSpaceDecision =
  | { ok: true; projectId: string; spaceId: string }
  | { ok: false; projectId: string; reason: 'unmapped' };

/** The K13 rule: the mapped space, or a refusal. */
export function pickOwningSpace(projectId: string, mapping: OwningSpaceMapping): OwningSpaceDecision {
  const spaceId = mapping.get(projectId);
  return spaceId ? { ok: true, projectId, spaceId } : { ok: false, projectId, reason: 'unmapped' };
}

/** Report columns only — shown next to a decision, never an input to it. */
export interface OwningSpaceReportRow {
  projectId: string;
  spaceId: string;
  /** Activity in the space on this folder over the last 30 days. */
  activity30d: number;
  /** True when the node owner (`accounts.is_owner`) created this space. */
  createdByOwner: boolean;
}

export interface LaunchSpaceCandidate {
  spaceId: string;
  /** True when the loopback owner created this space (`spaces.created_by_identity`). */
  createdByOwner: boolean;
  /** `spaces.created_at`, ISO-8601. */
  createdAt: string;
}

/**
 * NOT K13. Launch bootstrap on a node where the launch folder has no grant at
 * all yet — nothing to split, no owner to ask: the owner's oldest space, then
 * the oldest space, then the lowest id (independent of input order).
 */
export function launchFolderSpace(candidates: readonly LaunchSpaceCandidate[]): string | null {
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort((a, b) =>
    (Number(b.createdByOwner) - Number(a.createdByOwner))
    || (Date.parse(a.createdAt) - Date.parse(b.createdAt))
    || a.spaceId.localeCompare(b.spaceId));
  return ranked[0]!.spaceId;
}
