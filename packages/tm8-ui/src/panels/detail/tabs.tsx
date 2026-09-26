/* ONE COMPONENT LEFT IN THIS FILE, so one import list.
   Everything the deleted Discussion renderer and Activity feed pulled in —
   the rich-input composer, `feed-model`'s markdown preparation, `Avatar`,
   `ActivityItem` — went with them. Those imports outlived their last use, and
   nothing in this package fails on a dead import: there is no lint step, and
   `tsc` is configured without `noUnusedLocals`. They only get removed if
   whoever deletes the code deletes them too. */
import { Fragment, useState, type ReactNode } from 'react';
import type { Connections, EdgeGroup, EntityDetail } from '@tm8/contract';
import { Chip, Eyebrow } from '../../kit';
/* THE ONE FORMATTER, called directly — the same three helpers `channel-screen`
   uses to draw its feed, because this section is now the same shape: a day
   divider over rows stamped with a clock time. `kit/time`'s rule is that no
   surface formats a date FOR ITSELF, not that no surface may ask it to. */
import { absTime, clockTime, dayLabel, dayStart, relTime } from '../../kit/time';
import { CONVERSATION_KIND, KindIcon, edgeVerb, edgeVerbBoth, getKind, isConversationEdge } from '../../domain';
import { EmptyBody } from './PanelStates';

/**
 * THE SHARED TABS — designed once, rendered for every kind.
 *
 * Connections and Discussion are KIND-AGNOSTIC BY CONSTRUCTION: they render
 * `EdgeGroup`s and a host-composed conversation surface, neither of which
 * varies by kind. That is why "every kind gets the same tabs" costs nothing —
 * two of the three are the same component everywhere, so it is one
 * implementation, not fifteen.
 */

// ---------------------------------------------------------------------------
// Discussion
// ---------------------------------------------------------------------------

/**
 * WHAT A DISCUSSION REPLY CARRIES TO THE WIRE.
 *
 * The body was always the whole message this composer could express, which is
 * why its placeholder advertised an `@` it did not have. `PostMessageInput`
 * has accepted `mentionIds` and `attachmentIds` since the batch write landed;
 * the tab simply never sent them. Widening the dispatcher (rather than adding
 * side-channel props) keeps the message ONE object at every call site — the
 * same shape the channel composer's `onPost` already takes.
 */
// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/** One peer entity and every edge type this entity shares with it. */
interface PeerGroup {
  peer: EdgeGroup['edges'][number]['source'];
  /** Edge types, deduped by direction+type. */
  relations: {
    key: string;
    /** The verb phrase, read from this entity's side (`domain/edge-verbs`). */
    verb: string;
    /** Null when one peer holds the type BOTH ways and the two are one phrase. */
    direction: 'outgoing' | 'incoming' | null;
    count: number;
    unresolvedHard: boolean;
    /**
     * When this relation came to exist — the OLDEST edge under the key, so a
     * relation counted twice is dated from when it FIRST existed rather than
     * from whichever edge the seam happened to return last.
     */
    since: string | null;
    /** When it last changed. Equal to `since` unless an edge was re-written. */
    changed: string | null;
  }[];
  /** Any unresolved HARD dependency anywhere in this peer's relations. */
  unresolvedHard: boolean;
  /** Newest instant anywhere in this peer's edges — the row's sort key. */
  latest: number;
}

/**
 * THE DISCUSSION RENDERER AND ITS COMPOSER ARE GONE FROM HERE.
 *
 * `DiscussionTab`, `discussionBranches`, `MessageBranch`, `MessageRow`,
 * `MessageBody`, `mentionComponents`, `DiscussionReplyContext`,
 * `ProvenanceChip`, `sigilInvitation` and the tab's own `Composer` used to live
 * in this file — about 560 lines drawing a conversation over `messages.list`.
 *
 * They were deleted rather than kept beside the shared surface, because the two
 * did not agree and the weaker one was the one always on screen:
 * `messages.list` applies the `anchored` predicate ALONE, where
 * `entities.feed` resolves per anchor kind (on a session, `session_chat_v1` —
 * `anchored` plus `authored`, `caused` and `replies`). It also did not page: it
 * printed "N more replies" and stopped.
 *
 * The Discussion tab now renders a host-composed surface
 * (`views/conversationSurface.tsx` → `discussionSurfaceFor`), the same
 * "TWO ENTRANCES, ONE SURFACE" rule `views/graphSurface.tsx` already applies to
 * Connections/Graph. A fallback copy kept here "just in case" would be the
 * second renderer that produced the divergence in the first place.
 */
function groupByPeer(groups: readonly EdgeGroup[], selfId: string): PeerGroup[] {
  const byPeer = new Map<string, PeerGroup>();
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
      const created = instantOf(edge.createdAt);
      const changed = edge.updatedAt ?? edge.createdAt;
      if (instantOf(changed) !== null) entry.latest = Math.max(entry.latest, instantOf(changed)!);
      const existing = entry.relations.find((r) => r.key === key);
      if (existing) {
        existing.count += 1;
        existing.unresolvedHard ||= hard;
        existing.since = olderOf(existing.since, edge.createdAt);
        existing.changed = newerOf(existing.changed, changed);
      } else {
        entry.relations.push({
          key,
          verb: edgeVerb(group.type, group.direction),
          direction: group.direction,
          count: 1,
          unresolvedHard: hard,
          since: created === null ? null : edge.createdAt,
          changed: instantOf(changed) === null ? null : changed,
        });
      }
      entry.unresolvedHard ||= hard;
    }
  }
  for (const entry of byPeer.values()) entry.relations = mergeBothWays(entry.relations);
  /* NEWEST FIRST — see `TIME IS THE ORDER` above `ConnectionsTab`. Ties keep
     first-appearance order, so edges written in one transaction (which share
     an instant to the microsecond) do not reshuffle between renders. */
  return [...byPeer.values()].sort(
    (a, b) => b.latest - a.latest || (seenAt.get(a.peer.id) ?? 0) - (seenAt.get(b.peer.id) ?? 0),
  );
}

/**
 * ONE PHRASE FOR A TWO-WAY RELATION. A session that messaged a peer and heard
 * back from it holds `messaged` in both directions; "Messaged · Heard from" is
 * one conversation said twice. Only types whose verb row declares a `both`
 * phrase merge — for the rest the two directions are different facts.
 */
function mergeBothWays(relations: PeerGroup['relations']): PeerGroup['relations'] {
  const out: PeerGroup['relations'] = [];
  for (const rel of relations) {
    const type = rel.key.slice(rel.key.indexOf(':') + 1);
    const both = edgeVerbBoth(type);
    const twin = both
      ? out.find((r) => r.direction !== null && r.direction !== rel.direction && r.key.endsWith(`:${type}`))
      : undefined;
    if (!both || !twin) {
      out.push({ ...rel });
      continue;
    }
    twin.key = `both:${type}`;
    twin.verb = both;
    twin.direction = null;
    twin.count += rel.count;
    twin.unresolvedHard ||= rel.unresolvedHard;
    twin.since = olderOf(twin.since, rel.since);
    twin.changed = newerOf(twin.changed, rel.changed);
  }
  return out;
}

/** The messages posted on or from this entity, as one summary. */
interface Conversation {
  /** Distinct messages. */
  total: number;
  /** Written from this entity (`authored_from`). */
  sent: number;
  /** Posted on this entity by someone else (`anchored_to` only). */
  postedHere: number;
  /** Newest instant across them, or null when none is dated. */
  latest: string | null;
}

function conversationOf(groups: readonly EdgeGroup[], selfId: string): Conversation {
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

function olderOf(current: string | null, candidate: string | undefined | null): string | null {
  const a = instantOf(current);
  const b = instantOf(candidate);
  if (b === null) return current;
  if (a === null) return candidate ?? null;
  return b < a ? (candidate ?? null) : current;
}

function newerOf(current: string | null, candidate: string | undefined | null): string | null {
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
function newestRelationInstant(entry: PeerGroup): string | null {
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
function whenClause(since: string | null, changed: string | null): string {
  if (!since && !changed) return '';
  if (since && changed && since !== changed) return ' · linked, then updated';
  return ' · linked';
}

/** The same clause for a whole peer row, across every relation it holds. */
function peerWhenClause(entry: PeerGroup): string {
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
function withDayDividers(peers: PeerGroup[]): (PeerGroup & { dayLabel: string | null })[] {
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

/**
 * The row's clock, as a real `<time>` — the machine-readable instant travels
 * with the label and the full local date and time is on inspect, the same
 * contract `kit/Timestamp` gives every other surface. It is spelt out here
 * rather than reusing that component because this stamp deliberately shows the
 * CLOCK and not a relative label: under a day divider, "3d ago" would be the
 * one thing on the row that did not say when.
 *
 * Renders nothing at all for an edge the seam gave no usable instant.
 */
function PeerWhen({ entry }: { entry: PeerGroup }) {
  const at = newestRelationInstant(entry);
  if (at === null) return null;
  const absolute = absTime(at);
  return (
    <time
      className="pn-peers__when"
      dateTime={at}
      title={`${peerTitle(entry.peer.kind, entry.peer.title)}${peerWhenClause(entry)} · ${absolute}`}
      aria-label={absolute}
    >
      {clockTime(at)}
    </time>
  );
}

/**
 * "Task · Fix the login bug" — the kind NAMED, on the hover of every chip in
 * this tab.
 *
 * The drawn mark (`KindIcon`) is the first-glance answer to "which are what",
 * and the reason this tab was rebuilt: the old marks were near-identical
 * lozenges. The word is the second half of that answer, for the reader who has
 * not yet learned the mark. Both come from the registry, so neither can drift
 * from the other or from the kind.
 */
function peerTitle(kind: string, title: string): string {
  return `${getKind(kind).label} · ${title}`;
}

/**
 * The summary's detail clauses. Each is drawn only when it has something to
 * say: a task has no messages "sent" from it, so it reads "7 messages · posted
 * here" rather than "0 sent".
 */
function conversationParts(c: Conversation): string[] {
  const parts: string[] = [];
  if (c.sent > 0) parts.push(`${c.sent} sent from here`);
  if (c.postedHere > 0) parts.push(c.sent > 0 ? `${c.postedHere} posted here` : 'posted here');
  if (c.latest !== null) parts.push(`latest ${relTime(c.latest)}`);
  return parts;
}

function ConnectionsViewSwitch({
  view,
  onChange,
}: {
  view: 'list' | 'graph';
  onChange: (next: 'list' | 'graph') => void;
}) {
  return (
    <div className="pn-viewswitch" role="group" aria-label="Connections view">
      {(['list', 'graph'] as const).map((id) => (
        <button
          key={id}
          type="button"
          className={id === view ? 'pn-viewswitch__opt pn-viewswitch__opt--on' : 'pn-viewswitch__opt'}
          aria-pressed={id === view}
          onClick={() => onChange(id)}
        >
          {id === 'list' ? 'List' : 'Graph'}
        </button>
      ))}
    </div>
  );
}

/**
 * "two axes: vertical = where it lives · horizontal = what it connects to."
 * Parent/children come from the hierarchy; LINKED rows are one per connected
 * entity, each showing the edge types it holds with this one.
 */
/**
 * TIME IS THE ORDER, AND IT IS ON THE ROW.
 *
 * `EdgeView` has carried `createdAt` and `updatedAt` on every edge since it was
 * written, and this tab discarded both. Rows came out in the order the seam
 * happened to group edge TYPES in — stable, but arbitrary — so a PR linked a
 * minute ago sat below one linked in March, and no row said which was which.
 * The tab could be read as an inventory and not as a history, which is what it
 * was being asked for: connections "should show properly in timeline", and
 * tracked PRs should sit "exactly when those got created, updated".
 *
 * THIS IS THE ONLY TIMELINE THE PANEL HAS. The fourth tab that used to answer
 * "what happened to this entity" was removed on 2026-08-19 (see the tombstone
 * further down this file) because no host ever fed it. Nothing replaced it, so
 * the question landed here — on the surface that holds the edges and already
 * knew when each one was made.
 *
 * WHAT IT WILL NOT DO. Every instant drawn here is the EDGE's — when the link
 * was made, and when it was last re-written. The forge's own facts about a
 * tracked pull request (merged-at, CI, `fetchedAt`) are NOT dates on this row:
 * `fetchedAt` is when tm8 last looked, not when the PR changed, and drawing it
 * as "updated" would be a fabrication with a timestamp on it. What is shown is
 * what the edge can prove.
 */
/**
 * THE GRAPH IS A VIEW OF CONNECTIONS, NOT A FEATURE OF SESSIONS.
 *
 * The ego-network canvas shipped as a fourth chip on `work_session`, so "what
 * is this connected to, drawn" became something only a session could answer —
 * "everything is centered around the session", in code. Nothing in that canvas
 * is session-shaped: it walks `entities.connections` outward from any focus id,
 * and this tab renders the very same edges as a list. They are two readings of
 * one fact, so they belong behind one switch. The list is the PRECISE reading
 * (every peer, every relation type, named); the graph is the SHAPE (what
 * clusters, what sits two hops out, what is a hub).
 *
 * Making it a VIEW rather than a per-kind chip is what makes a task-wise graph
 * cost nothing: `graphSurfaceFor` is already passed to this panel by all five
 * hosts, so every kind gains it in one place instead of fifteen.
 *
 * LIST STAYS THE DEFAULT: it answers a specific question, it needs no seam, and
 * it cannot fail — the graph reads the network, and a host without a seam has
 * no network to read. A host that passes no surface draws no switch, rather
 * than a control that would do nothing.
 */
export function ConnectionsTab({
  detail,
  connections,
  onOpenEntity,
  graph,
  launchContext,
  header,
  onOpenDiscussion,
}: {
  detail: EntityDetail;
  connections?: Connections;
  onOpenEntity?: (id: string) => void;
  /**
   * Switches the panel to its Discussion tab. Absent ⇒ the message summary is
   * drawn without a button, rather than with one that does nothing.
   */
  onOpenDiscussion?: () => void;
  /** The ego-network canvas for THIS entity. Absent ⇒ no switch is drawn. */
  graph?: ReactNode;
  /**
   * A session's LAUNCH CONTEXT section — every selection that went into its
   * launch — drawn first, above the edges. Host-composed; absent for other kinds.
   */
  launchContext?: ReactNode;
  /**
   * The entity's SELECTION HEADER section (I9a) — what a launch reads when
   * deciding whether to pick this entity. Host-composed; absent for kinds that
   * cannot carry an authored header.
   */
  header?: ReactNode;
}) {
  const [view, setView] = useState<'list' | 'graph'>('list');
  const groups: EdgeGroup[] = [
    ...(connections?.outgoing ?? detail.connections.outgoing),
    ...(connections?.incoming ?? detail.connections.incoming),
  ];
  const peers = groupByPeer(groups, detail.id);
  const conversation = conversationOf(groups, detail.id);
  const parent = detail.hierarchy.parent;
  const children = detail.hierarchy.children.items;
  const empty = !parent && children.length === 0 && peers.length === 0 && conversation.total === 0;

  if (graph !== undefined && view === 'graph') {
    return (
      <div
        className="pn-body pn-body--graph"
        id="tabpanel-connections"
        role="tabpanel"
        aria-labelledby="tab-connections"
      >
        <ConnectionsViewSwitch view={view} onChange={setView} />
        <div className="pn-connections-graph">{graph}</div>
      </div>
    );
  }

  return (
    <div className="pn-body" id="tabpanel-connections" role="tabpanel" aria-labelledby="tab-connections">
      {graph === undefined ? null : <ConnectionsViewSwitch view={view} onChange={setView} />}
      {launchContext}
      {header}
      {empty ? (
        <EmptyBody
          glyph="⊕"
          sentence="Nothing linked yet — drag an entity here, or press / and type its name."
          actionLabel="⊕ link an entity"
        />
      ) : null}

      {parent ? (
        <section className="pn-section">
          <Eyebrow faint>PARENT</Eyebrow>
          <div className="pn-chiprow">
            <Chip
              glyph={<KindIcon kind={parent.kind} />}
              onClick={() => onOpenEntity?.(parent.id)}
              title={peerTitle(parent.kind, parent.title)}
            >
              {parent.title}
            </Chip>
          </div>
        </section>
      ) : null}

      {peers.length > 0 ? (
        <section className="pn-section">
          <Eyebrow faint>{`LINKED · ${peers.length}`}</Eyebrow>
          <ul className="pn-peers">
            {withDayDividers(peers).map((entry) => (
              <Fragment key={entry.peer.id}>
                {entry.dayLabel ? (
                  /* THE DIVIDER IS WHAT MAKES THIS READ AS A TIMELINE. Without
                     it every row past the relative window printed the same bare
                     date — four links made minutes apart all said "28 Jul" — and
                     the section looked like an inventory again. The day is said
                     ONCE, over the run it covers, and each row below it needs
                     only its clock time. Same two-part treatment, and the same
                     two helpers, as the channel feed. */
                  <li className="pn-peers__day" data-testid="pn-peers-day">
                    <span className="pn-peers__day-label">{entry.dayLabel}</span>
                  </li>
                ) : null}
                {/* ONE LINE PER ROW: title · verbs · clock, on a grid, so a long
                    title truncates instead of pushing its relations and its time
                    onto a second line. The full title is on the chip's hover. */}
                <li className="pn-peers__row">
                  <Chip
                    glyph={<KindIcon kind={entry.peer.kind} />}
                    onClick={() => onOpenEntity?.(entry.peer.id)}
                    /* An unresolved HARD dependency is why something is blocked —
                       the chip says so rather than looking like any other link. */
                    title={
                      entry.unresolvedHard
                        ? 'unresolved hard dependency'
                        : peerTitle(entry.peer.kind, entry.peer.title)
                    }
                  >
                    <span className="pn-peers__title">{entry.peer.title}</span>
                  </Chip>
                  <div className="pn-peers__rels">
                    {entry.relations.map((rel) => (
                      <span
                        className={
                          rel.unresolvedHard ? 'pn-peers__rel pn-peers__rel--hard' : 'pn-peers__rel'
                        }
                        key={rel.key}
                        title={
                          rel.unresolvedHard
                            ? 'unresolved hard dependency'
                            : `${rel.verb}${whenClause(rel.since, rel.changed)}`
                        }
                      >
                        {/* The verb carries the direction ("Depends on" and
                            "Needed by" are one edge type read from its two
                            ends), so no arrow is drawn. */}
                        {rel.verb}
                        {rel.count > 1 ? ` · ${rel.count}` : ''}
                      </span>
                    ))}
                  </div>
                  {/* WHEN — the fact this row has always held and never showed.
                      The stamp is the peer's newest edge, which is also what the
                      list is ordered on: a PR linked at 21:31 and a commit linked
                      at 23:12 are two moments, and this is where they stop
                      looking like one. The day is on the divider above, so the
                      row carries the clock alone; the full local date and time
                      rides on the element for anyone who needs it. */}
                  <PeerWhen entry={entry} />
                </li>
              </Fragment>
            ))}
          </ul>
        </section>
      ) : null}

      {conversation.total > 0 ? (
        /* THE MESSAGES, AS ONE ROW. Every message posted on or from this entity
           used to be a row of its own here — on a working session, most of the
           list — repeating what the Discussion tab already shows in full. */
        <section className="pn-section">
          <div className="pn-convo" data-testid="pn-convo">
            <span className="pn-convo__glyph" aria-hidden>
              <KindIcon kind={CONVERSATION_KIND} />
            </span>
            <span className="pn-convo__text">
              <span className="pn-convo__count">
                {conversation.total === 1 ? '1 message' : `${conversation.total} messages`}
              </span>
              {conversationParts(conversation).map((part) => (
                <span key={part}>{` · ${part}`}</span>
              ))}
            </span>
            {onOpenDiscussion ? (
              <button type="button" className="pn-convo__open" onClick={onOpenDiscussion}>
                Open Messages →
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {children.length > 0 ? (
        <section className="pn-section">
          <Eyebrow faint>{`CHILDREN · ${children.length}`}</Eyebrow>
          <div className="pn-chiprow">
            {children.map((c) => (
              <Chip
                key={c.id}
                glyph={<KindIcon kind={c.kind} />}
                onClick={() => onOpenEntity?.(c.id)}
                title={peerTitle(c.kind, c.title)}
              >
                {c.title}
              </Chip>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity — REMOVED
// ---------------------------------------------------------------------------

/**
 * `ActivityTab` (actor · verb · date, over `entities.activity`) stood here
 * until 2026-08-19, when the user removed the fourth tab.
 *
 * IT WAS DELETED RATHER THAN LEFT UNMOUNTED because no host ever fed it: the
 * panel's `activity` prop was optional and absent at all five mount sites, so
 * the tab rendered "No activity recorded on this entity yet." on every entity
 * in the product, every time it was opened. That is the enabled-inert class
 * this panel's own honesty rules ban, sitting in the bar the panel navigates
 * by — and charging the tabs that DO answer something for its width (see
 * `PANEL_TABS` in ./chrome.tsx).
 *
 * The seam op is untouched and unrelated: `entities.activity` still backs the
 * channel feed and the CLI.
 *
 * (A second orphaned docblock stood below this one, describing the Discussion
 * composer's `sigilInvitation` — a function deleted in an earlier pass whose
 * comment was left behind. Removed for the same reason as the dead imports
 * above: a comment with no code under it is a claim nothing can falsify.)
 */
