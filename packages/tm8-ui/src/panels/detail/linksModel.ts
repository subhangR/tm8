/**
 * THE LINKS TAB'S MODEL — every derivation both of its readings share.
 *
 * The seam groups edges BY TYPE. The tab inverts that to one row per PEER
 * (`groupByPeer`), and then draws those rows two ways: grouped by family
 * (`linksSections`, the Links view) or as a history (`withDayDividers`, the
 * Timeline view). Both views read the same `PeerGroup`s, so a peer can never
 * say one thing in one view and another in the other.
 */
import type { ActorSummary, EdgeGroup, EntitySummary } from '@tm8/contract';
import { dayLabel, dayStart } from '../../kit/time';
import {
  EDGE_FAMILY_ORDER,
  edgeFamily,
  edgeVerb,
  edgeVerbBoth,
  isConversationEdge,
  type EdgeFamily,
} from '../../domain';

export interface Relation {
  key: string;
  type: string;
  /** The verb phrase, read from this entity's side (`domain/edge-verbs`). */
  verb: string;
  /** Null when one peer holds the type BOTH ways and the two are one phrase. */
  direction: 'outgoing' | 'incoming' | null;
  family: EdgeFamily;
  count: number;
  unresolvedHard: boolean;
  /** A hard dependency that HAS been met — drawn as resolved, not as a blocker. */
  resolvedHard: boolean;
  /**
   * Every edge under this key carries `props.endedAt` — a `working_on` claim
   * that is over. Drawn as ended, so a finished run does not read as current.
   */
  ended: boolean;
  /**
   * When this relation came to exist — the OLDEST edge under the key, so a
   * relation counted twice is dated from when it FIRST existed rather than
   * from whichever edge the seam happened to return last.
   */
  since: string | null;
  /** When it last changed. Equal to `since` unless an edge was re-written. */
  changed: string | null;
  /** Who made the oldest edge under the key; null when the seam did not say. */
  by: ActorSummary | null;
}

/** One peer entity and every edge type this entity shares with it. */
export interface PeerGroup {
  peer: EntitySummary;
  relations: Relation[];
  /** Any unresolved HARD dependency anywhere in this peer's relations. */
  unresolvedHard: boolean;
  /** Newest instant anywhere in this peer's edges — the row's sort key. */
  latest: number;
  /** The relation the Links view files this peer under (see `primaryOf`). */
  primary: Relation;
}

export function groupByPeer(groups: readonly EdgeGroup[], selfId: string): PeerGroup[] {
  const byPeer = new Map<string, Omit<PeerGroup, 'primary'>>();
  const seenAt = new Map<string, number>();
  for (const group of groups) {
    for (const edge of group.edges) {
      // The far end of the edge relative to THIS entity.
      const peer = edge.source.id === selfId ? edge.target : edge.source;
      // Messages posted on or from this entity are Discussion content; they
      // are summarised by `conversationOf`, not drawn one row each.
      if (isConversationEdge(group.type, group.direction, peer.kind)) continue;
      let entry = byPeer.get(peer.id);
      if (!entry) {
        entry = { peer, relations: [], unresolvedHard: false, latest: Number.NEGATIVE_INFINITY };
        byPeer.set(peer.id, entry);
        seenAt.set(peer.id, seenAt.size);
      }
      const key = `${group.direction}:${group.type}`;
      const hard = edge.hard === true && edge.resolved === false;
      const met = edge.hard === true && edge.resolved === true;
      const ended = typeof edge.props?.endedAt === 'string';
      const created = instantOf(edge.createdAt);
      const changed = edge.updatedAt ?? edge.createdAt;
      if (instantOf(changed) !== null) entry.latest = Math.max(entry.latest, instantOf(changed)!);
      const existing = entry.relations.find((r) => r.key === key);
      if (existing) {
        existing.count += 1;
        existing.unresolvedHard ||= hard;
        existing.resolvedHard &&= met;
        existing.ended &&= ended;
        if (olderOf(existing.since, edge.createdAt) !== existing.since) existing.by = edge.createdBy ?? existing.by;
        existing.since = olderOf(existing.since, edge.createdAt);
        existing.changed = newerOf(existing.changed, changed);
      } else {
        entry.relations.push({
          key,
          type: group.type,
          verb: edgeVerb(group.type, group.direction),
          direction: group.direction,
          family: edgeFamily(group.type, group.direction),
          count: 1,
          unresolvedHard: hard,
          resolvedHard: met,
          ended,
          since: created === null ? null : edge.createdAt,
          changed: instantOf(changed) === null ? null : changed,
          by: edge.createdBy ?? null,
        });
      }
      entry.unresolvedHard ||= hard;
    }
  }
  const peers = [...byPeer.values()].map((entry) => {
    const relations = mergeBothWays(entry.relations);
    return { ...entry, relations, primary: primaryOf(relations) };
  });
  /* NEWEST FIRST — the Timeline's whole claim, and the order inside each Links
     section too. Ties keep first-appearance order, so edges written in one
     transaction (which share an instant to the microsecond) do not reshuffle
     between renders. */
  return peers.sort(
    (a, b) => b.latest - a.latest || (seenAt.get(a.peer.id) ?? 0) - (seenAt.get(b.peer.id) ?? 0),
  );
}

/**
 * ONE PHRASE FOR A TWO-WAY RELATION. A session that messaged a peer and heard
 * back from it holds `messaged` in both directions; "Messaged · Heard from" is
 * one conversation said twice. Only types whose verb row declares a `both`
 * phrase merge — for the rest the two directions are different facts.
 */
function mergeBothWays(relations: Relation[]): Relation[] {
  const out: Relation[] = [];
  for (const rel of relations) {
    const both = edgeVerbBoth(rel.type);
    const twin = both
      ? out.find((r) => r.direction !== null && r.direction !== rel.direction && r.type === rel.type)
      : undefined;
    if (!both || !twin) {
      out.push({ ...rel });
      continue;
    }
    twin.key = `both:${rel.type}`;
    twin.verb = both;
    twin.direction = null;
    twin.count += rel.count;
    twin.unresolvedHard ||= rel.unresolvedHard;
    twin.resolvedHard &&= rel.resolvedHard;
    twin.ended &&= rel.ended;
    twin.since = olderOf(twin.since, rel.since);
    twin.changed = newerOf(twin.changed, rel.changed);
  }
  return out;
}

/**
 * WHICH SECTION A PEER IS FILED UNDER when it holds several relations. A peer
 * is drawn ONCE (the keyboard cursor walks peers, not edges), so one relation
 * has to decide: a blocker first, then the most specific family, and the
 * deliberately vague `relates_to` only when nothing better is there. The other
 * relations still appear on the row.
 */
function primaryOf(relations: Relation[]): Relation {
  const rank = (rel: Relation): number => {
    if (rel.unresolvedHard) return 0;
    if (rel.family === 'sessions') return 60;
    if (rel.type === 'relates_to') return 50;
    return 1 + ['code', 'work', 'files', 'people'].indexOf(rel.family);
  };
  return relations.reduce((best, rel) => (rank(rel) < rank(best) ? rel : best));
}

// ---------------------------------------------------------------------------
// The Links view: sections by family
// ---------------------------------------------------------------------------

export type SectionId = 'blocking' | EdgeFamily;

export interface LinksSection {
  id: SectionId;
  peers: PeerGroup[];
  /** The peers again, split by the primary relation they are filed under. */
  byRelation: { key: string; verb: string; direction: Relation['direction']; peers: PeerGroup[] }[];
}

/**
 * Blocking first (only when something blocks), then the families in their
 * fixed order. Inside a section, sub-groups appear in the order of their
 * newest peer, because the peers arrive newest-first.
 */
export function linksSections(peers: readonly PeerGroup[]): LinksSection[] {
  const order: SectionId[] = ['blocking', ...EDGE_FAMILY_ORDER];
  const sections = new Map<SectionId, LinksSection>(order.map((id) => [id, { id, peers: [], byRelation: [] }]));
  for (const entry of peers) {
    const id: SectionId = entry.unresolvedHard ? 'blocking' : entry.primary.family;
    const section = sections.get(id)!;
    section.peers.push(entry);
    const { key, verb, direction } = entry.primary;
    let sub = section.byRelation.find((s) => s.key === key);
    if (!sub) section.byRelation.push((sub = { key, verb, direction, peers: [] }));
    sub.peers.push(entry);
  }
  return order.map((id) => sections.get(id)!).filter((section) => section.peers.length > 0);
}

// ---------------------------------------------------------------------------
// The peer's own state, as one status word
// ---------------------------------------------------------------------------

export type StatusTone = 'run' | 'done' | 'todo' | 'block' | 'info' | 'merged' | 'idle';

export interface PeerStatus {
  label: string;
  tone: StatusTone;
}

const TASK_STATUS: Record<string, PeerStatus> = {
  open: { label: 'open', tone: 'todo' },
  pulled: { label: 'pulled', tone: 'todo' },
  working: { label: 'working', tone: 'run' },
  in_review: { label: 'in review', tone: 'info' },
  done: { label: 'done', tone: 'done' },
  blocked: { label: 'blocked', tone: 'block' },
  cancelled: { label: 'cancelled', tone: 'idle' },
};

const SESSION_STATUS: Record<string, PeerStatus> = {
  spawning: { label: 'starting', tone: 'info' },
  running: { label: 'live', tone: 'run' },
  idle: { label: 'idle', tone: 'todo' },
  exited: { label: 'exited', tone: 'idle' },
  failed: { label: 'failed', tone: 'block' },
};

const PR_STATE: Record<string, PeerStatus> = {
  open: { label: 'open', tone: 'run' },
  merged: { label: 'merged', tone: 'merged' },
  closed: { label: 'closed', tone: 'idle' },
  draft: { label: 'draft', tone: 'todo' },
};

/**
 * The status a peer's summary already carries — task status, session state,
 * pull-request state. Null for kinds that have no status, rather than a
 * placeholder: the row simply draws none.
 */
export function peerStatus(peer: EntitySummary): PeerStatus | null {
  const state = peer.state as { kind?: string; status?: unknown; state?: unknown } | undefined;
  if (!state || state.kind !== peer.kind) return null;
  if (peer.kind === 'task' && typeof state.status === 'string') return TASK_STATUS[state.status] ?? null;
  if (peer.kind === 'work_session' && typeof state.status === 'string') return SESSION_STATUS[state.status] ?? null;
  if (peer.kind === 'pull_request' && typeof state.state === 'string') return PR_STATE[state.state] ?? null;
  return null;
}

/** A pull request's CI verdict, or a commit's short sha — the one forge fact a row adds. */
export function forgeFact(peer: EntitySummary): string | null {
  const state = peer.state as { kind?: string; ciStatus?: unknown; sha?: unknown; number?: unknown } | undefined;
  if (!state || state.kind !== peer.kind) return null;
  if (peer.kind === 'pull_request') {
    const parts: string[] = [];
    if (typeof state.number === 'number' && state.number > 0) parts.push(`#${state.number}`);
    if (state.ciStatus === 'passing') parts.push('CI passing');
    if (state.ciStatus === 'failing') parts.push('CI failing');
    if (state.ciStatus === 'pending') parts.push('CI running');
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (peer.kind === 'commit' && typeof state.sha === 'string' && state.sha.length > 0) return state.sha.slice(0, 7);
  return null;
}

// ---------------------------------------------------------------------------
// Messages, summarised
// ---------------------------------------------------------------------------

/** The messages posted on or from this entity, as one summary. */
export interface Conversation {
  /** Distinct messages. */
  total: number;
  /** Written from this entity (`authored_from`). */
  sent: number;
  /** Posted on this entity by someone else (`anchored_to` only). */
  postedHere: number;
  /** Newest instant across them, or null when none is dated. */
  latest: string | null;
}

export function conversationOf(groups: readonly EdgeGroup[], selfId: string): Conversation {
  const authored = new Set<string>();
  const anchored = new Set<string>();
  let latest: string | null = null;
  for (const group of groups) {
    for (const edge of group.edges) {
      const peer = edge.source.id === selfId ? edge.target : edge.source;
      if (!isConversationEdge(group.type, group.direction, peer.kind)) continue;
      (group.type === 'authored_from' ? authored : anchored).add(peer.id);
      latest = newerOf(latest, edge.updatedAt ?? edge.createdAt);
    }
  }
  const all = new Set([...authored, ...anchored]);
  return {
    total: all.size,
    sent: authored.size,
    postedHere: [...anchored].filter((id) => !authored.has(id)).length,
    latest,
  };
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * WHEN, DERIVED ONLY FROM WHAT THE EDGE ACTUALLY CARRIES.
 *
 * Every one of these returns `null` rather than a substitute for an instant it
 * cannot parse, and every caller renders NOTHING for a `null`. An undated edge
 * is drawn undated; it is never dated "now", and it never sorts to the top of a
 * list whose whole claim is that the top is the most recent thing that happened.
 */
function instantOf(value: string | undefined | null): number | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function olderOf(current: string | null, candidate: string | undefined | null): string | null {
  const a = instantOf(current);
  const b = instantOf(candidate);
  if (b === null) return current;
  if (a === null) return candidate ?? null;
  return b < a ? (candidate ?? null) : current;
}

export function newerOf(current: string | null, candidate: string | undefined | null): string | null {
  const a = instantOf(current);
  const b = instantOf(candidate);
  if (b === null) return current;
  if (a === null) return candidate ?? null;
  return b > a ? (candidate ?? null) : current;
}

/**
 * The instant a peer row is stamped with, and the same value it is sorted on —
 * the newest change across its relations. One derivation, so the column reads
 * top-to-bottom as the descending sequence the order promises.
 */
export function newestRelationInstant(entry: PeerGroup): string | null {
  let newest: string | null = null;
  for (const rel of entry.relations) newest = newerOf(newest, rel.changed ?? rel.since);
  return newest;
}

/**
 * The clause a hover ends with. "linked, then updated" appears ONLY when the
 * edge was genuinely re-written after it was made: two identical instants are
 * one fact, and reporting an update would invent a second event that never
 * happened. Empty when there is no instant at all.
 */
export function whenClause(since: string | null, changed: string | null): string {
  if (!since && !changed) return '';
  if (since && changed && since !== changed) return ' · linked, then updated';
  return ' · linked';
}

/** The same clause for a whole peer row, across every relation it holds. */
export function peerWhenClause(entry: PeerGroup): string {
  const since = entry.relations.reduce<string | null>((acc, rel) => olderOf(acc, rel.since), null);
  return whenClause(since, newestRelationInstant(entry));
}

/**
 * Mark the first row of each DAY run with that day's label.
 *
 * The list is already newest-first, so a run is contiguous by construction and
 * one pass finds every boundary. An UNDATED peer opens no run and closes none:
 * it carries no label, and it does not reset the previous day either, because
 * it is not evidence that the day changed.
 */
export function withDayDividers<T extends PeerGroup>(peers: readonly T[]): (T & { dayLabel: string | null })[] {
  let previousDay: number | null = null;
  return peers.map((entry) => {
    const at = newestRelationInstant(entry);
    const day = dayStart(at);
    if (day === null) return { ...entry, dayLabel: null };
    if (day === previousDay) return { ...entry, dayLabel: null };
    previousDay = day;
    return { ...entry, dayLabel: dayLabel(at) };
  });
}
