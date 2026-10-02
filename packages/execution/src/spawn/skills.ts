import type { SkillReference } from '@tm8/contract';

/** Cached metadata from the teammate-only ancestor walk. Never read skill bodies. */
export interface ResolvedSkillRow extends Partial<SkillReference> {
  entityId: string;
  entityVersion?: number;
  name: string;
  description?: string;
  depth: number;
  /**
   * Set when the skill is equipped on a spawn TASK (`equips` task → skill)
   * rather than on the persona chain: the task that brought it, so the
   * manifest can say why the skill is present.
   */
  viaTaskId?: string;
}
export interface SkillResolution {
  skills: ResolvedSkillRow[];
  dropped: string[];
}

/** A skill's identity for collisions: its file path, else its normalized name. */
export function skillIdentityKey(row: Pick<ResolvedSkillRow, 'name' | 'sourcePath'>): string {
  return row.sourcePath ? `path:${row.sourcePath}` : `name:${row.name.normalize('NFC').trim().toLowerCase()}`;
}

/**
 * TASK-LEVEL COLLISIONS NEVER FAIL A SPAWN. A persona hierarchy is curated, so
 * two same-name skills at one level of it are a mistake worth refusing to
 * spawn over (`resolveSkills` throws). Task skills are not curated: the attach
 * palette lets anyone pick two different skills that share a name. So among
 * the task rows (`depth < 0`) the FIRST in the given order wins, and every
 * loser is returned for the caller to declare as skipped. Persona rows pass
 * through untouched, and so does their throw.
 */
export function splitTaskSkillCollisions<T extends ResolvedSkillRow>(rows: readonly T[]): { kept: T[]; collided: T[] } {
  const claimed = new Set<string>();
  const kept: T[] = [];
  const collided: T[] = [];
  for (const row of rows) {
    if (row.depth >= 0) {
      kept.push(row);
      continue;
    }
    const key = skillIdentityKey(row);
    if (claimed.has(key)) {
      collided.push(row);
      continue;
    }
    claimed.add(key);
    kept.push(row);
  }
  return { kept, collided };
}

/**
 * A LAUNCH SELECTION IS NOT CURATED EITHER. The launch card pre-ticks the
 * persona's equipment and lets a person tick any space skill beside it, so a
 * selection can name two different skills that share a name (a space holding a
 * full skill and a short reference card of it). That is a pick, not a
 * hierarchy mistake, and it must not fail the launch.
 *
 * `picked` holds the ids the person added for THIS launch (not equipped). A
 * picked skill beats an equipped one of the same identity, since ticking it
 * was the explicit choice; between two picks the first in order wins. Every
 * loser is returned for the caller to declare as skipped. Collisions between
 * equipped rows only are left alone, so the persona path still throws.
 */
export function splitSelectionSkillCollisions<T extends ResolvedSkillRow>(
  rows: readonly T[],
  picked: ReadonlySet<string>,
): { kept: T[]; collided: T[] } {
  const pickedWinner = new Map<string, string>();
  for (const row of rows) {
    if (!picked.has(row.entityId)) continue;
    const key = skillIdentityKey(row);
    if (!pickedWinner.has(key)) pickedWinner.set(key, row.entityId);
  }
  const kept: T[] = [];
  const collided: T[] = [];
  for (const row of rows) {
    const winner = pickedWinner.get(skillIdentityKey(row));
    if (winner === undefined || winner === row.entityId) kept.push(row);
    else collided.push(row);
  }
  return { kept, collided };
}

/** Nearest-first equipment. Files have path identity; graph cards have name identity. */
export function resolveSkills(rows: readonly ResolvedSkillRow[]): SkillResolution {
  const seen = new Set<string>();
  const claims = new Map<string, number>();
  const skills: ResolvedSkillRow[] = [];
  for (const row of [...rows].sort((a, b) => a.depth - b.depth)) {
    if (seen.has(row.entityId)) continue;
    seen.add(row.entityId);
    const key = skillIdentityKey(row);
    const depth = claims.get(key);
    if (depth === row.depth) {
      throw new Error(`ambiguous skill "${row.name}": two different skills with that name are equipped ${row.depth < 0 ? 'on the spawn\'s tasks' : `at the same level of the team member hierarchy (depth ${row.depth})`}. Rename one, or equip only one.`);
    }
    if (depth !== undefined) continue;
    claims.set(key, row.depth);
    // Explicit projection prevents old callers carrying body text into manifests.
    const { entityId, entityVersion, name, description, depth: hops, provider, level, root, sourcePath, dirName, frontmatter, loaderMetadata, contentHash, missing, lastSeenAt, viaTaskId } = row;
    skills.push({ entityId, entityVersion, name, description, depth: hops, provider, level, root, sourcePath, dirName, frontmatter, loaderMetadata, contentHash, missing, lastSeenAt, ...(viaTaskId ? { viaTaskId } : {}) });
  }
  return { skills, dropped: [] };
}
