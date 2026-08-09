/**
 * The sessions data class — the work_session list, and the liveness rules that
 * decide what the rest of the workspace is allowed to do with one.
 *
 * The queries and the live/finished split are LIFTED from `SessionsScreen`
 * rather than reinvented, because that surface is the proven one (it is what
 * G1A drove) and two different answers to "is this session live?" is exactly
 * the kind of divergence that ships unnoticed — one panel offering a Terminate
 * button the pane beside it has already greyed out.
 *
 * Cadences match the proven surface too: the LIST is cheap and drives a badge,
 * the OPEN session's status gates the terminal's input and the Prompt/Terminate
 * affordances, so it reads faster.
 */
import { useEffect, useRef, useState } from 'react';
import type { EntityId, EntitySummary } from '../../collab-v2/types/contract';
import type { RealFacade } from '../RealFacade';
import { sessionsQuery } from './queries';
import { usePolledCollection } from './usePolledCollection';

/** How often the session list re-reads. Sessions change state without a graph event. */
export const LIST_POLL_MS = 4000;
/** The open session polls faster — its status drives the terminal's liveness. */
export const DETAIL_POLL_MS = 1500;

/**
 * The fields tm8 projects onto a `work_session`. Declared locally because the
 * module's `EntityState` union genuinely has no `work_session` arm — inventing
 * one in the shared contract types would be editing a snapshot Atlas's team
 * owns to describe a kind it does not model.
 */
export interface SessionState {
  status?: string;
  agentTool?: string | null;
  model?: string | null;
  startedAt?: string | null;
  exitedAt?: string | null;
  /** 083's discriminator. Optional — a pre-083 node omits it. See `isWork`. */
  sessionKind?: string | null;
}

export function sessionState(s: EntitySummary): SessionState {
  return (s.state ?? {}) as unknown as SessionState;
}

/**
 * THE SINGLE LIVENESS PREDICATE. Everything that gates on "can I still talk to
 * this agent?" — the terminal's input, Prompt, Terminate, the live/finished
 * grouping — asks this and nothing else.
 *
 * Phrased as "not finished" rather than "is running" deliberately: `spawning`
 * and `idle` are both states a user can still act on, and a whitelist of
 * running-ish statuses silently drops any status the server adds later into the
 * DEAD bucket, which would strand a live agent behind disabled buttons.
 */
export function isLive(s: EntitySummary | null | undefined): boolean {
  if (!s) return false;
  const status = String(sessionState(s).status ?? '');
  return status !== 'exited' && status !== 'failed';
}

/** `2026-07-25T18:40:12Z` → `18:40:12`. Absent stays absent — never "—" as a time. */
export function clock(iso: string | null | undefined): string | null {
  return iso ? String(iso).slice(11, 19) : null;
}

export interface SessionGroups {
  live: EntitySummary[];
  finished: EntitySummary[];
}

/**
 * Split the list the way the Terminals tab renders it.
 *
 * `SessionsScreen` computed `finished` as `!running.includes(s)` — an O(n²)
 * scan that also re-derived the predicate a second time. One pass over the
 * single predicate keeps the two buckets provably complementary: every session
 * lands in exactly one, which is what makes the counts trustworthy.
 */
export function groupSessions(sessions: EntitySummary[]): SessionGroups {
  const live: EntitySummary[] = [];
  const finished: EntitySummary[] = [];
  for (const s of sessions) (isLive(s) ? live : finished).push(s);
  return { live, finished };
}

/**
 * IS THIS SESSION WORK, or a private credential login terminal?
 *
 * 083 mints the login terminals `credentials.loginSessions.start` opens with
 * `session_kind='credential'`. They are a member authenticating an agent tool
 * against their own account — not work — and they must not sit in the session
 * lists this module feeds (architect Ruling 16).
 *
 * PHRASED AS THE INVERSE OF THE SQL, ON PURPOSE. The database column is NOT
 * NULL so server SQL tests `session_kind = 'agent'` directly; here the field is
 * OPTIONAL and a session read from a node predating 083 carries none. Testing
 * `=== 'agent'` would drop every one of those from the list — a bug that
 * reproduces on no fresh local data and blanks the list for users on an older
 * node. An absent field is WORK.
 */
export function isWork(s: EntitySummary | null | undefined): boolean {
  if (!s) return false;
  return sessionState(s).sessionKind !== 'credential';
}

/**
 * The shared session list. Every panel that wants sessions calls this.
 *
 * Login terminals are removed HERE rather than in each tab, so `sessions`,
 * `live` and `finished` are all already free of them and no consumer — present
 * or future — has to remember. The three tabs that render these
 * (SessionTree/AgentsTab/TerminalsTab) get it by construction.
 */
export function useSessions(facade: RealFacade, spaceId: string) {
  const { items, error, reload } = usePolledCollection(facade, sessionsQuery(spaceId), LIST_POLL_MS);
  const work = items?.filter(isWork) ?? null;
  return { sessions: work, error, reload, ...groupSessions(work ?? []) };
}

// ---------------------------------------------------------------------------
// Session links — which agent, and which task
// ---------------------------------------------------------------------------

/**
 * WHO is running this session, and WHAT is it working on.
 *
 * Neither is on the `work_session` summary. `collections.query` returns the
 * session's own row and nothing about its edges, so a panel that wants to name
 * the agent has exactly two options: read the edges, or invent something. The
 * edges are real and they are reachable — `entities.get` carries a populated
 * `connections` block — so this hook reads them, and the panel gets to render a
 * true name instead of an id or a guess. Verified against the live node:
 *
 *   outgoing `relates_to` → team_member   ("Smoke Agent")
 *   outgoing `working_on` → task          ("AtlasA parent 556344")
 *
 * `work_session.content.workingOn` looks like it would answer this and does
 * not — it is a hollow `[]` (see capabilities.ts). Reading it would return an
 * empty array forever and look exactly like a session with no task.
 *
 * WHY A VERSION-KEYED CACHE. The session list polls every 4s and a panel may
 * show 30+ rows. Enriching per render would be 30 `entities.get` calls every
 * four seconds, forever, for data that almost never changes. Keyed by
 * `id@version`, a poll that returns unchanged sessions costs ZERO requests, and
 * a session whose version moves is re-read exactly once. The cache is
 * module-level so every consumer of the same session shares one answer.
 */
export interface SessionLinks {
  /** The `team_member` running this session, via `relates_to`. */
  agent: EntitySummary | null;
  /** The `task` this session is working on, via `working_on`. */
  task: EntitySummary | null;
}

const EMPTY_LINKS: SessionLinks = { agent: null, task: null };

const linkCache = new Map<string, SessionLinks>();
const linksInFlight = new Set<string>();

const cacheKey = (s: EntitySummary): string => `${s.id}@${s.version}`;

/** Pull the first edge target of a given type off a detail's connections. */
function targetOfType(
  detail: { connections?: { outgoing?: Array<{ type: string; edges: Array<{ target?: EntitySummary }> }> } },
  type: string,
): EntitySummary | null {
  const group = (detail.connections?.outgoing ?? []).find((g) => g.type === type);
  return group?.edges?.[0]?.target ?? null;
}

async function loadLinks(facade: RealFacade, session: EntitySummary): Promise<void> {
  const key = cacheKey(session);
  if (linkCache.has(key) || linksInFlight.has(key)) return;
  linksInFlight.add(key);
  try {
    const detail = await facade.getEntity(session.id);
    linkCache.set(key, {
      agent: targetOfType(detail, 'relates_to'),
      task: targetOfType(detail, 'working_on'),
    });
  } catch {
    // A failed enrichment must not blank the row or retry on a hot loop. Cache
    // the empty answer against THIS version: the row renders without a name
    // (which the panel must degrade honestly for anyway, since a session
    // genuinely may have no agent edge) and a later version re-reads.
    linkCache.set(key, EMPTY_LINKS);
  } finally {
    linksInFlight.delete(key);
  }
}

/**
 * Links for a list of sessions, resolved in the background.
 *
 * Returns a Map keyed by session id. A session that has not resolved yet is
 * simply ABSENT from the map rather than present-with-nulls — the caller can
 * then tell "not loaded yet" from "loaded, and there is genuinely no agent",
 * which are different sentences and must not render the same way.
 */
export function useSessionLinks(
  facade: RealFacade,
  sessions: EntitySummary[] | null,
): Map<EntityId, SessionLinks> {
  const [, bump] = useState(0);
  const known = useRef(new Set<string>());

  useEffect(() => {
    if (!sessions?.length) return;
    let alive = true;
    const missing = sessions.filter((s) => !linkCache.has(cacheKey(s)));
    if (missing.length === 0) return;

    // Bounded concurrency: a first paint over 30+ finished sessions would
    // otherwise open 30 simultaneous reads against a node answering every one
    // of them from Postgres. Six at a time keeps the panel responsive without
    // making the burst the server's problem.
    const CONCURRENCY = 6;
    let cursor = 0;
    const pump = async (): Promise<void> => {
      while (alive && cursor < missing.length) {
        const next = missing[cursor++]!;
        await loadLinks(facade, next);
        if (alive) bump((n) => n + 1);
      }
    };
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, pump));
    return () => { alive = false; };
    // Keyed on the id@version set, so a poll returning identical rows does not
    // restart the effect and an unchanged list costs nothing.
  }, [facade, sessions?.map(cacheKey).join(',')]);

  const out = new Map<EntityId, SessionLinks>();
  for (const s of sessions ?? []) {
    const hit = linkCache.get(cacheKey(s));
    if (hit) { out.set(s.id, hit); known.current.add(s.id); }
  }
  return out;
}

/** Test seam — the link cache outlives any component tree by design. */
export function __resetSessionLinks(): void {
  linkCache.clear();
  linksInFlight.clear();
}

/**
 * One session, polled fast, for whoever has it open.
 *
 * Not routed through `usePolledCollection`: that primitive is keyed by a
 * CollectionQuery, and this is an `entities.get`. Sharing the registry would
 * mean inventing a fake query key for a different operation — the kind of
 * near-miss abstraction that makes the next reader trust the wrong invariant.
 */
export function useSessionDetail(facade: RealFacade, sessionId: string | null) {
  const [session, setSession] = useState<EntitySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      setError(null);
      return;
    }
    let alive = true;
    // Cleared on id change so a stale session never lingers under a new id for
    // one poll — the terminal beside it would be attached to the new PTY while
    // the header still described the old one.
    setSession(null);
    const read = () => {
      facade.getEntity(sessionId).then(
        (fresh) => { if (alive) { setSession(fresh); setError(null); } },
        (err: unknown) => { if (alive) setError(String((err as Error)?.message ?? err)); },
      );
    };
    read();
    const id = setInterval(read, DETAIL_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [facade, sessionId]);

  return { session, error, live: isLive(session) };
}
