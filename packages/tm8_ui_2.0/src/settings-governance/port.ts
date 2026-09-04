/**
 * THE GOVERNANCE PORT — the only place `settings-governance/` knows a seam
 * exists.
 *
 * Same shape as `settings-space/port.ts` (half A of T2) and for the same
 * reason, stated there: everything below the port receives plain values and
 * cannot tell a fixture from a real node. The coordinator wires
 * `governancePortFromSeam(seam, spaceId)`; nothing in this directory imports a
 * seam implementation.
 *
 * READS ONLY — and unlike half A, that is not even a choice here. Measured
 * against `src/data/seam.ts` (read in full, 2026-07-29): there is no
 * `projects.*` family, no interaction-profile command, and `entityKinds()` is
 * a read with no write beside it. The port exposes no method for any write
 * this surface draws, so a future component cannot quietly acquire one; each
 * refusal lives in `reasons.ts` with its mechanism named.
 *
 * WHY IT IS TESTED AGAINST A REAL FIXTURE SEAM (`port-seam.test.ts`): the
 * brief's four-links lesson. Declaration → data → implementation → CALL can
 * each be green while the feature is dead, because nobody asserted the caller
 * passes the argument. The port test drives an actual `createFixtureSeam()`
 * and asserts on what comes BACK.
 */
import type { EntityKind, EntityKindDef, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { kindBySlug } from '../domain/registry';

/**
 * The two kinds this surface queries, reached through REGISTRY DATA rather
 * than typed as literals (§15.2, and this lane's own guard).
 *
 * A slug is the registry's public route word (WLT §2.1) — `kindBySlug` is the
 * same lookup the `k/{slug}` route performs, so this is not a literal in
 * disguise: it asks the registry which kind owns a route, and throws if the
 * registry ever stops answering. A silently-wrong kind here would render an
 * empty, confident projects list; a throw is strictly better.
 */
function kindOfSlugOrThrow(slug: string): EntityKind {
  const row = kindBySlug(slug);
  if (!row) {
    throw new Error(
      `settings-governance: no registry row owns the “${slug}” route — the port cannot name the kind to query.`,
    );
  }
  return row.kind as EntityKind;
}

export const PROJECT_SLUG = 'projects';
export const PROFILE_SLUG = 'interaction-profiles';

export interface GovernancePort {
  /** Space-side linked projects — the materialized per-space projection. */
  linkedProjects(): Promise<readonly EntitySummary[]>;
  /** Every interaction profile in the space, all lifecycle states. */
  profiles(): Promise<readonly EntitySummary[]>;
  /** Custom-kind rows. The seam's ONE custom-kind source (seam.ts:169). */
  entityKinds(): Promise<readonly EntityKindDef[]>;
  /**
   * THE liveness predicate, passed through untouched. R-UI-5: liveness comes
   * exclusively from the seam and is never derived in a surface. This port
   * hands the function along rather than any computed verdict, so a consumer
   * cannot accidentally receive a stale answer baked at read time.
   */
  statusOf: Seam['liveness']['statusOf'];
}

export function governancePortFromSeam(seam: Seam, spaceId: SpaceId): GovernancePort {
  return {
    async linkedProjects() {
      const result = await seam.query({ spaceId, kinds: [kindOfSlugOrThrow(PROJECT_SLUG)] });
      return result.page.items;
    },
    async profiles() {
      const result = await seam.query({ spaceId, kinds: [kindOfSlugOrThrow(PROFILE_SLUG)] });
      return result.page.items;
    },
    async entityKinds() {
      return seam.entityKinds(spaceId);
    },
    statusOf: (session) => seam.liveness.statusOf(session),
  };
}

/**
 * What the screens consume. Every member distinguishes NOT YET READ from READ
 * AND EMPTY, because the two produce different screens and a surface that
 * collapses them tells the user a space has no projects when in fact the read
 * failed.
 */
export interface GovernanceData {
  projects: LoadState<readonly EntitySummary[]>;
  profiles: LoadState<readonly EntitySummary[]>;
  kinds: LoadState<readonly EntityKindDef[]>;
  /** Passed through from the port — never a precomputed verdict (R-UI-5). */
  statusOf: GovernancePort['statusOf'];
}

export type LoadState<T> =
  | { phase: 'loading' }
  | { phase: 'ready'; value: T }
  | { phase: 'failed'; message: string };

/** A load state that has never been asked. Used by hosts rendering the screen bare. */
export const NOT_LOADED: LoadState<never> = { phase: 'loading' };
