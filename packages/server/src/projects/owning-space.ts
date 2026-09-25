/**
 * THE PICKER SEAM (plan 01a0d9eb W11, K13): which ONE space owns a folder.
 *
 * Since migration 230 a folder is granted to at most one space. Two callers
 * need to choose that space from several candidates:
 *
 *   - launch bootstrap (`ensureLaunchResources`) on a fresh node: every
 *     candidate has no activity yet, so the tie-break alone decides;
 *   - W11-migrate, splitting the folders that were linked into two or more
 *     spaces before 230: the space with the most activity in the last 30 days
 *     keeps the folder, the others get their own grant or lose it.
 *
 * Both call this one function, so the rule lives in one place.
 *
 * K13: most 30-day activity wins; ties go to the node owner's personal/first
 * space — the oldest space the owner created — then to the oldest space, then
 * to the lowest id (so the answer never depends on input order).
 */
export interface OwningSpaceCandidate {
  spaceId: string;
  /** Activity in the space on this folder over the last 30 days (0 when unknown/fresh). */
  activity30d: number;
  /** True when the node owner created this space (`spaces.created_by_identity`). */
  createdByOwner: boolean;
  /** `spaces.created_at`, ISO-8601. */
  createdAt: string;
}

export function pickOwningSpace(candidates: readonly OwningSpaceCandidate[]): string | null {
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort((a, b) =>
    (b.activity30d - a.activity30d)
    || (Number(b.createdByOwner) - Number(a.createdByOwner))
    || (Date.parse(a.createdAt) - Date.parse(b.createdAt))
    || a.spaceId.localeCompare(b.spaceId));
  return ranked[0]!.spaceId;
}
