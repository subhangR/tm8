/**
 * THE LAUNCH RECENTS — which personas THIS viewer actually launches, in the
 * order they last did it.
 *
 * WHY THIS EXISTS. The teammate roster had no ordering at all. `data.launch`
 * builds it from `Object.values(entities)`, so the order was the domain store's
 * key-insertion order: the localStorage seed first, then whatever hydrate
 * returned, then live events as they arrived. That is not a sort, it is a
 * by-product, and it reshuffles between boots. On a space with a real roster
 * the owner's report was that picking the right teammate is guesswork.
 *
 * It was never only cosmetic. `LaunchSheet` and `LaunchQuickConfig` both seed
 * their selection from `teammates[0]`, and `NewSessionScreen` takes
 * `teammates[0]` as THE teammate with no picker at all — so an accidental order
 * chose the default persona, and re-seeded the model and agent tool from it.
 *
 * WHAT IS RECORDED, AND WHEN. One id, appended on a SPAWN THAT SUCCEEDED —
 * never on selection. A picker you opened and closed is not a launch, and a
 * spawn the node refused is not one either; recording either would let the top
 * of the list fill with personas that never ran. `data.spawn` is the single
 * seam every launch surface commits through, which is why the write lives at
 * exactly one call site instead of once per picker.
 *
 * WHERE THIS LIVES, AND THE HONEST CONSEQUENCE. localStorage, keyed by node and
 * space, exactly like the launch-source cache next door. It is a PER-BROWSER
 * order: your other device keeps its own, the CLI cannot see it, and clearing
 * site data resets it. That is a deliberate trade for shipping without a schema
 * change — there is no per-member preferences endpoint to hang it on today —
 * and nothing here forecloses a server-side one, because the stored value is
 * just an id list and the ordering rule is a pure function over it.
 *
 * KEYED BY NODE AND SPACE, for the reason the launch cache states: a named
 * Server's teammates are not this node's, and two spaces do not share personas.
 * Like that cache it is keyed by neither account nor viewer, so an explicit
 * sign-out has to drop it — see `clearLaunchRecents`.
 *
 * AN ID IS NOT A ROW. Only ids are stored, so nothing here can put a teammate
 * in a picker: an id matching no current row simply ranks nothing. That is the
 * property that makes a stale entry harmless — a deleted persona cannot be
 * resurrected into the roster by having once been launched.
 */

/**
 * Bumped whenever the stored shape changes. A miss on this prefix IGNORES the
 * old payload rather than coercing it — the same rule the launch cache follows,
 * for the same reason.
 */
const RECENTS_VERSION = 'v1';
const KEY_PREFIX = `tm8.launch-recents.${RECENTS_VERSION}`;

/**
 * How many picks are remembered. Comfortably past a busy space's whole roster,
 * so in practice nothing falls off; the bound exists because localStorage is a
 * shared 5MB origin budget and an unbounded list here could evict the auth
 * session. Anything past the cap simply returns to the alphabetical tail, which
 * is the correct behaviour for the least-recently-used end of an LRU.
 */
const MAX_REMEMBERED = 50;

interface RecentsPayload {
  savedAt: string;
  ids: string[];
}

function keyFor(nodeKey: string, spaceId: string): string {
  return `${KEY_PREFIX}.${nodeKey}.${spaceId}`;
}

/**
 * EVERY localStorage access is guarded, for the reasons `launch-cache.ts`
 * spells out: private-mode Safari throws on write, a full quota throws on
 * write, and a disabled-storage policy throws on READ. An ordering hint may
 * never be the thing that breaks a launch.
 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * The remembered order, most recent FIRST. Empty when there is nothing stored,
 * nothing readable, or nothing of the right shape — every one of which means
 * the same thing to the caller: rank nothing, fall back to the alphabetical
 * tail. That is why this returns `[]` rather than null; a "no recents yet"
 * roster is still perfectly ordered.
 */
export function readLaunchRecents(nodeKey: string, spaceId: string): readonly string[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(keyFor(nodeKey, spaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentsPayload;
    if (!parsed || !Array.isArray(parsed.ids)) return [];
    // A structural check, not a cast. A non-string in here would reach a Map
    // key and rank some teammate by accident.
    return normalise(parsed.ids.filter((id): id is string => typeof id === 'string' && id !== ''));
  } catch {
    // Corrupt payload — drop it rather than let it throw on every future boot.
    try {
      store.removeItem(keyFor(nodeKey, spaceId));
    } catch {
      /* nothing further to do */
    }
    return [];
  }
}

/**
 * Dedupe FIRST-WINS and cap. First-wins is the whole semantic: the earliest
 * occurrence is the most recent pick, so a later duplicate is the older event
 * and must be the one that goes.
 */
function normalise(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_REMEMBERED) break;
  }
  return out;
}

/**
 * Record a launch and hand back the NEW order.
 *
 * Returning the list rather than only writing it is what lets the caller move
 * its React state on without a re-read: a write followed by a `readLaunchRecents`
 * would be a second parse, and — when storage is unavailable — would answer with
 * the order as it was BEFORE the pick, quietly making the feature look broken on
 * exactly the browsers that can least afford a mystery.
 *
 * `current` is the caller's in-memory order. It is trusted over storage because
 * the caller is the one that has been accumulating this session's picks; a
 * re-read here would race a second tab and could resurrect an order this
 * browser has already moved past.
 */
export function rememberLaunchPick(
  nodeKey: string,
  spaceId: string,
  teamMemberId: string,
  current: readonly string[] = [],
): readonly string[] {
  if (!teamMemberId) return normalise(current);
  // Move-to-front. `normalise` drops the previous occurrence for us, because
  // the new head is now the first one it sees.
  const next = normalise([teamMemberId, ...current]);
  const store = storage();
  if (!store) return next;
  try {
    const payload: RecentsPayload = { savedAt: new Date().toISOString(), ids: [...next] };
    store.setItem(keyFor(nodeKey, spaceId), JSON.stringify(payload));
  } catch {
    // Quota, or a storage policy. The order is still correct for this session;
    // it just will not survive the reload. Swallowed deliberately — there is no
    // action the viewer could take, and a launch that SUCCEEDED must not report
    // a failure because its ordering hint could not be persisted.
  }
  return next;
}

/**
 * DROP EVERY SPACE'S RECENTS FOR ONE NODE — what an explicit sign-out owes.
 *
 * The list is keyed by node and space and never by account, exactly like the
 * launch cache, so there is no key that could keep two viewers apart on one
 * browser. Left behind, it would rank the NEXT person's teammate picker by the
 * previous person's launches — a quieter leak than seeding their rows, but the
 * same class, and it names who they work as.
 */
export function clearLaunchRecents(nodeKey: string): void {
  const store = storage();
  if (!store) return;
  try {
    const prefix = `${KEY_PREFIX}.${nodeKey}.`;
    // Snapshot the keys BEFORE removing any: `key(i)` walks a live index, and
    // deleting mid-walk skips entries.
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // Storage refused. Nothing stored, nothing to forget.
  }
}
