/**
 * THE LAUNCH-SOURCE CACHE — teammates and interaction profiles, kept in the
 * browser so the pickers are populated on the first frame.
 *
 * WHY THIS EXISTS. `data.launch` is derived from the domain store, and the
 * domain store starts EMPTY on every page load. The teammate and model selects
 * therefore have nothing to offer until boot's `collections.query` for
 * `team_member` comes back — and every later failure mode of that read (a slow
 * node, a 503, a space switch, a resync) reopens the same empty window. The
 * owner's report was "the dropdowns are often empty"; the missing prop on the
 * kind screens was the deterministic half of that, and this is the other half:
 * the option set had no existence independent of one in-flight request.
 *
 * WHAT IS CACHED, AND WHAT IS NOT. Only the two OPTION-SET kinds. These are not
 * paged lists the viewer scrolls; they are the complete set of choices behind
 * two pickers, they are small, and they change rarely. Tasks, docs and sessions
 * are deliberately NOT cached: those ARE paged, they change constantly, and a
 * stale row in a list is a lie about the work, whereas a stale row in a picker
 * is corrected the moment boot's authoritative read lands.
 *
 * THE HONEST LIMIT, stated rather than hidden. A cached row is a PHOTOGRAPH
 * from the last session. A teammate deleted while this browser was closed will
 * be offered for the seconds between seed and the first authoritative read.
 * Three things bound that:
 *   - the seed only ever reaches `Object.values(entities)` consumers — the
 *     launch pickers. It writes no `rows` entry, so no LIST can show a cached
 *     row that the server did not return.
 *   - `hydrate` replaces this cache wholesale, so the window is one boot long.
 *   - the launch memo already drops `deletedAt !== null`, so a deletion seen
 *     while online removes the option immediately.
 * The alternative — an empty picker — is the defect this replaces, and an
 * option that turns out to be stale refuses AT SPAWN with the node's own words,
 * which is a far better failure than a control with nothing in it.
 *
 * KEYED BY NODE AND SPACE. A named Server's teammates must never be offered
 * while pointed at a different node, and two spaces do not share personas.
 */
import type { EntitySummary } from '@tm8/contract';

/**
 * Bumped whenever the stored shape changes. A miss on this prefix means the old
 * payload is IGNORED, never coerced — deserialising a shape we no longer
 * understand is how a cache turns into a crash on someone else's boot.
 */
const CACHE_VERSION = 'v1';
const KEY_PREFIX = `tm8.launch-sources.${CACHE_VERSION}`;

/** The kinds this cache is responsible for. Anything else is not stored. */
export const CACHED_LAUNCH_KINDS: ReadonlySet<string> = new Set([
  'team_member',
  'interaction_profile',
]);

/**
 * A defensive bound. Not an expected size — 26 teammates is a busy space — but
 * localStorage is a shared 5MB budget for the whole origin, and an unbounded
 * write here could evict the auth session or the theme.
 */
const MAX_CACHED_ROWS = 400;

interface CachedPayload {
  savedAt: string;
  rows: EntitySummary[];
}

function keyFor(nodeKey: string, spaceId: string): string {
  return `${KEY_PREFIX}.${nodeKey}.${spaceId}`;
}

/**
 * `serverBaseUrl` is undefined for the local node and a relay path for a named
 * one. Both collapse to a stable, readable segment.
 */
export function nodeKeyOf(serverBaseUrl: string | undefined): string {
  return serverBaseUrl && serverBaseUrl.trim() !== '' ? serverBaseUrl.replace(/[^\w.-]+/g, '_') : 'local';
}

/**
 * EVERY localStorage access is guarded. Private-mode Safari throws on write,
 * a full quota throws on write, and a disabled-storage policy throws on READ.
 * None of those may reach boot: the cache is an accelerator, and an accelerator
 * that can break the workspace is worse than no accelerator.
 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** The cached option set, or null when there is nothing trustworthy to seed. */
export function readLaunchCache(nodeKey: string, spaceId: string): EntitySummary[] | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(keyFor(nodeKey, spaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPayload;
    if (!parsed || !Array.isArray(parsed.rows)) return null;
    // Structural check, not a cast. A row that does not carry the fields the
    // launch memo reads would otherwise reach `Object.values(entities)` and
    // throw somewhere far from here.
    const rows = parsed.rows.filter(
      (row): row is EntitySummary =>
        !!row &&
        typeof (row as EntitySummary).id === 'string' &&
        typeof (row as EntitySummary).spaceId === 'string' &&
        !!(row as EntitySummary).state &&
        CACHED_LAUNCH_KINDS.has((row as EntitySummary).state.kind),
    );
    return rows.length > 0 ? rows : null;
  } catch {
    // Corrupt payload — drop it rather than let it fail every future boot.
    try {
      store.removeItem(keyFor(nodeKey, spaceId));
    } catch {
      /* nothing further to do */
    }
    return null;
  }
}

/**
 * Replace the cached set WHOLESALE. Not a merge: a merge could never forget a
 * teammate that the server has stopped returning, so the cache would only ever
 * grow and deletions would be permanent locally. The caller passes the complete
 * current set, which is why this is written from the authoritative read.
 */
export function writeLaunchCache(
  nodeKey: string,
  spaceId: string,
  rows: readonly EntitySummary[],
): void {
  const store = storage();
  if (!store) return;
  const keep = rows
    .filter((row) => CACHED_LAUNCH_KINDS.has(row.state.kind) && row.deletedAt === null)
    .slice(0, MAX_CACHED_ROWS);
  try {
    if (keep.length === 0) {
      store.removeItem(keyFor(nodeKey, spaceId));
      return;
    }
    const payload: CachedPayload = { savedAt: new Date().toISOString(), rows: [...keep] };
    store.setItem(keyFor(nodeKey, spaceId), JSON.stringify(payload));
  } catch {
    // Quota or a storage policy. The workspace is fully functional without the
    // cache — it just pays the boot read before its pickers fill — so this is
    // swallowed deliberately rather than surfaced as a failure the viewer
    // cannot act on.
  }
}
