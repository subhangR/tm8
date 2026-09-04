/* ONE COMPONENT LEFT IN THIS FILE, so one import list.
   Everything the deleted Discussion renderer and Activity feed pulled in —
   the rich-input composer, `feed-model`'s markdown preparation, `Avatar`,
   `ActivityItem` — went with them. Those imports outlived their last use, and
   nothing in this package fails on a dead import: there is no lint step, and
   `tsc` is configured without `noUnusedLocals`. They only get removed if
   whoever deletes the code deletes them too. */
import { useState, type ReactNode } from 'react';
import type { Connections, EdgeGroup, EntityDetail } from '@tm8/contract';
import { Chip, Eyebrow } from '../../kit';
import { KindIcon, getKind } from '../../domain';
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
  /** Edge types, first-appearance order, deduped by direction+type. */
  relations: { key: string; label: string; direction: 'outgoing' | 'incoming'; count: number; unresolvedHard: boolean }[];
  /** Any unresolved HARD dependency anywhere in this peer's relations. */
  unresolvedHard: boolean;
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
  for (const group of groups) {
    for (const edge of group.edges) {
      // The far end of the edge relative to THIS entity.
      const peer = edge.source.id === selfId ? edge.target : edge.source;
      let entry = byPeer.get(peer.id);
      if (!entry) {
        entry = { peer, relations: [], unresolvedHard: false };
        byPeer.set(peer.id, entry);
      }
      const key = `${group.direction}:${group.type}`;
      const hard = edge.hard === true && edge.resolved === false;
      const existing = entry.relations.find((r) => r.key === key);
      if (existing) {
        existing.count += 1;
        existing.unresolvedHard ||= hard;
      } else {
        entry.relations.push({ key, label: group.label, direction: group.direction, count: 1, unresolvedHard: hard });
      }
      entry.unresolvedHard ||= hard;
    }
  }
  return [...byPeer.values()];
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
}: {
  detail: EntityDetail;
  connections?: Connections;
  onOpenEntity?: (id: string) => void;
  /** The ego-network canvas for THIS entity. Absent ⇒ no switch is drawn. */
  graph?: ReactNode;
}) {
  const [view, setView] = useState<'list' | 'graph'>('list');
  const groups: EdgeGroup[] = [
    ...(connections?.outgoing ?? detail.connections.outgoing),
    ...(connections?.incoming ?? detail.connections.incoming),
  ];
  const peers = groupByPeer(groups, detail.id);
  const parent = detail.hierarchy.parent;
  const children = detail.hierarchy.children.items;
  const empty = !parent && children.length === 0 && peers.length === 0;

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
      {empty ? (
        /*
         * THE HONEST EMPTY STATE, wave 3. Two lies stood here:
         *
         *   1. The SENTENCE taught two gestures — "drag an entity here, or
         *      press / and type its name" — and neither is implemented on any
         *      surface. An empty region "teaches the grammar in place" (T4
         *      C-1) only when the grammar exists; teaching a fiction is worse
         *      than silence.
         *   2. The BUTTON was enabled-inert: `actionLabel` with no `onAction`
         *      rendered a live "⊕ link an entity" whose click went nowhere
         *      (`PanelStates.tsx` drew it with `onClick={undefined}`) — the
         *      exact class the title span, the Terminate bar and the
         *      tombstone Restore were each caught in before it.
         *
         * CHECKED BEFORE REFUSING (wave-3 order): no ConnectionsTab mount —
         * EntityDetailPanel's arm or EntityView's aux column — passes any
         * relate/link mechanism, and the panel's `commands` port
         * (`AuthoringCommands`) carries no edge write. So the affordance
         * stays, DEAD AND SAYING WHY, with the one linking door that does
         * exist today named as the remedy. When a host grows a link flow,
         * `EmptyBody.onAction` is the wire to pass it through.
         */
        <EmptyBody
          glyph="⊕"
          sentence="Nothing linked yet."
          actionLabel="⊕ link an entity"
          actionUnavailableReason="linking is not wired on this surface — tm8 edge create <src> <type> <dst> writes the edge today"
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
            {peers.map((entry) => (
              <li className="pn-peers__row" key={entry.peer.id}>
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
                  {entry.peer.title}
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
                          : `${rel.direction} · ${rel.label}`
                      }
                    >
                      {/* Direction is part of the relation's meaning: "blocks"
                          and "blocked by" are the same edge type read two ways. */}
                      <span aria-hidden="true">{rel.direction === 'outgoing' ? '→' : '←'}</span>
                      {rel.label}
                      {rel.count > 1 ? ` · ${rel.count}` : ''}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
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
