import { useRef, useState, type ReactNode } from 'react';
import type {
  ActivityItem,
  Connections,
  EdgeGroup,
  EntityDetail,
  EntityId,
  Mention,
  MessageView,
} from '@tm8/contract';
import { Avatar, Chip, Eyebrow, Markdown, type MarkdownComponents } from '../../kit';
import { KindIcon, getKind } from '../../domain';
import type { FileUploadTask } from '../../files/upload';
import { ChooseFilesControl } from '../../files/ChooseFilesControl';
import { DisabledIconControl } from '../honesty/DisabledWithReason';
import {
  AttachmentChips,
  TriggerPopover,
  skillReference,
  useRichInput,
  type TriggerOption,
} from '../../rich-input';
/* Module-deep into the chat lane's PURE half — `feed-model` is plain functions
   with no React and no DOM. A message body is a message body wherever it is
   drawn, so the Discussion tab shares the channel's source preparation instead
   of growing a second copy that could drift from it. */
import { chatMarkdownSource, mentionIdInHref } from '../../channel-screen/feed-model';
import { EmptyBody } from './PanelStates';

/**
 * THE THREE SHARED TABS — designed once, rendered for every kind.
 *
 * Discussion, Connections and Activity are KIND-AGNOSTIC BY CONSTRUCTION:
 * they render `messages.list`, `EdgeGroup`s and `entities.activity` rows, none
 * of which vary by kind. That is why the four-tab law (D3) costs nothing —
 * three of the four tabs are the same component everywhere, so "every kind
 * gets four tabs" is one implementation, not fifteen.
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
// Activity
// ---------------------------------------------------------------------------

/**
 * "actor · verb · object — authorship never buried."
 *
 * The dot is coloured from the status ramp by event type, and one rule is
 * absolute here as everywhere: an `unknown` delivery is styled as a WARNING,
 * never as success.
 */
export function ActivityTab({ items }: { items: readonly ActivityItem[] }) {
  return (
    <div className="pn-body" id="tabpanel-activity" role="tabpanel" aria-labelledby="tab-activity">
      {items.length === 0 ? (
        <EmptyBody glyph="◫" sentence="No activity recorded on this entity yet." />
      ) : (
        <ul className="pn-activity">
          {items.map((item) => (
            <li className="pn-activity__row" key={item.id}>
              <span className={`pn-activity__dot pn-activity__dot--${verbTone(item.verb)}`} aria-hidden />
              {item.actor ? (
                <Avatar
                  actorId={item.actor.id}
                  provenance={item.actor.isAgent ? 'agent' : 'human'}
                  label={item.actor.displayName}
                  size={20}
                  src={item.actor.avatar ?? null}
                />
              ) : null}
              <span className="pn-activity__text">
                {`${item.actor?.displayName ?? 'someone'} ${humanizeVerb(item.verb)}`}
              </span>
              <span className="pn-activity__time">{relativeish(item.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Verb → ramp tone. Keyed on the VERB vocabulary, not on kind. `unknown`
 * anywhere in a delivery verb goes amber — the one mapping that is a rule
 * rather than a preference.
 */
function verbTone(verb: string): 'run' | 'wait' | 'info' | 'block' | 'idle' {
  if (verb.includes('unknown') || verb.includes('stale')) return 'wait';
  if (verb.includes('fail') || verb.includes('delete') || verb.includes('refus')) return 'block';
  if (verb.includes('complete') || verb.includes('deliver')) return 'run';
  if (verb.includes('link') || verb.includes('referenc')) return 'info';
  return 'idle';
}

function humanizeVerb(verb: string): string {
  return verb.replace(/[._]/g, ' ');
}

/**
 * Deliberately coarse: exact relative time needs a clock, and a clock in a
 * render path makes every test time-dependent. The date is shown plainly and
 * the precise timestamp rides on the element for anyone who needs it.
 */
function relativeish(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The clause the placeholder and the empty state both end with, built from
 * what is DECLARED rather than from what a designer once hoped would be here.
 * Returns `''` when neither sigil is live, so the invitation degrades to a
 * plain "reply below" instead of naming a key that does nothing.
 */
