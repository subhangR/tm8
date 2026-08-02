/**
 * Skill resolution across a team member's ancestor chain (sheet row #11).
 *
 * The graph already lets a `team_member` equip a `skill` (an `equips` edge,
 * registered in 001_core_graph.sql as "Capability selection feeding manifests")
 * and already nests team members in the homogeneous entity hierarchy. What did
 * not exist until now is the step between: nothing walked that chain, so
 * `composeManifest` emitted a hardcoded `skills: []` and a persona reached its
 * CLI with no capability at all.
 *
 * The ancestor WALK is SQL — it is a recursive CTE over `entities.parent_id`,
 * and the database is where that belongs. The COLLISION rule is here, in a pure
 * function, because it is the part with judgement in it and therefore the part
 * worth testing exhaustively without a database.
 */

/** One `equips` hit, as the ancestor-walk query returns it. */
export interface ResolvedSkillRow {
  /** Skill entity id. Distinguishes two same-named skills from one skill seen twice. */
  entityId: string;
  name: string;
  /** `public.skills.content` — the skill body rendered into the agent prompt. */
  body: string;
  /**
   * Hops from the invoked team member: 0 is the member itself, 1 its parent,
   * and so on. Lower is nearer.
   */
  depth: number;
}

/** What the CLI reads. Field names are Phoenix's; see composeManifest. */
export interface ManifestSkill {
  name: string;
  body: string;
}

export interface SkillResolutionOptions {
  /**
   * Hard cap on how many skills reach the manifest. A deep chain can accumulate
   * more prompt than the model has context for, and silently dropping the tail
   * would be indistinguishable from a persona that was never equipped.
   */
  maxSkills?: number;
}

export interface SkillResolution {
  skills: ManifestSkill[];
  /**
   * Names dropped by `maxSkills`, nearest-first order preserved. Non-empty means
   * the manifest is NOT the whole truth about this persona, and the caller is
   * expected to say so out loud rather than let it pass as complete.
   */
  dropped: string[];
}

/** Default cap. Generous for an org chart, low enough to notice a runaway. */
export const DEFAULT_MAX_SKILLS = 64;

/**
 * Normalisation for collision detection ONLY — the emitted skill keeps its
 * original name. Case and surrounding whitespace are not meaningful differences
 * between "Code Review" on a parent and "code review" on a child; treating them
 * as distinct would ship both and let the model reconcile them, which is the
 * one outcome nobody chose.
 */
function collisionKey(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/**
 * Nearest-wins resolution over the ancestor chain.
 *
 * - A skill equipped nearer the invoked member shadows a same-named skill from
 *   further up. The specific persona beats the general one; that is what makes
 *   nesting useful rather than merely additive.
 * - The SAME skill entity equipped at several levels is one skill, not a
 *   collision — dedup is by entity id first.
 * - Two DIFFERENT skill entities sharing a name at the SAME depth is ambiguous.
 *   There is no nearer-ness to break the tie, so this throws rather than
 *   picking one: a silent arbitrary choice would vary with row order and be
 *   invisible in the manifest.
 *
 * Output order is nearest-first, and stable within a depth by the order the
 * query returned (which is `name` — see the ORDER BY in loadSpawnContext), so
 * the manifest is byte-identical across two spawns of an unchanged graph.
 */
export function resolveSkills(
  rows: readonly ResolvedSkillRow[],
  options: SkillResolutionOptions = {},
): SkillResolution {
  const maxSkills = options.maxSkills ?? DEFAULT_MAX_SKILLS;

  const sorted = [...rows].sort((a, b) => a.depth - b.depth);

  const seenEntities = new Set<string>();
  // collisionKey -> the depth that claimed it, for same-depth ambiguity detection.
  const claimedAt = new Map<string, number>();
  const winners: ManifestSkill[] = [];

  for (const row of sorted) {
    if (seenEntities.has(row.entityId)) continue;
    seenEntities.add(row.entityId);

    const key = collisionKey(row.name);
    const claimDepth = claimedAt.get(key);

    if (claimDepth === undefined) {
      claimedAt.set(key, row.depth);
      winners.push({ name: row.name, body: row.body });
      continue;
    }

    // Same name, same distance, different entity: nothing to prefer.
    if (claimDepth === row.depth) {
      throw new Error(
        `ambiguous skill "${row.name}": two different skills with that name are equipped at the ` +
          `same level of the team member hierarchy (depth ${row.depth}). Rename one, or equip only one.`,
      );
    }
    // Otherwise the nearer one already won; this ancestor copy is shadowed.
  }

  if (winners.length <= maxSkills) {
    return { skills: winners, dropped: [] };
  }
  return {
    skills: winners.slice(0, maxSkills),
    dropped: winners.slice(maxSkills).map((s) => s.name),
  };
}
