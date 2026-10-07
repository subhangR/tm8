/* ONE COMPONENT LEFT IN THIS FILE, so one import list.
   Everything the deleted Discussion renderer and Activity feed pulled in —
   the rich-input composer, `feed-model`'s markdown preparation, `Avatar`,
   `ActivityItem` — went with them. Those imports outlived their last use, and
   nothing in this package fails on a dead import: there is no lint step, and
   `tsc` is configured without `noUnusedLocals`. They only get removed if
   whoever deletes the code deletes them too. */
import { useRef, useState, type ReactNode } from 'react';
import type { Connections, EdgeGroup, EntityDetail } from '@tm8/contract';
import { Chip, Eyebrow } from '../../kit';
import { relTime } from '../../kit/time';
import { CONVERSATION_KIND, KindIcon, edgeVerb } from '../../domain';
import { EmptyBody } from './PanelStates';
import { useLinksCursor } from './linksCursor';
import { conversationOf, groupByPeer, type Conversation } from './linksModel';
import {
  BlockedBanner,
  LinksGrouped,
  LinksStats,
  TimelineFilters,
  TimelineRows,
  peerTitle,
  type TimelineFilter,
} from './linksViews';

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

/* The model (one row per peer, families, status, time) lives in `./linksModel`
   and the two list readings in `./linksViews`; this file composes them. */

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

type ConnectionsView = 'links' | 'timeline' | 'graph';

const VIEW_LABEL: Record<ConnectionsView, string> = { links: 'Links', timeline: 'Timeline', graph: 'Graph' };

function ConnectionsViewSwitch({
  view,
  onChange,
  withGraph,
}: {
  view: ConnectionsView;
  onChange: (next: ConnectionsView) => void;
  withGraph: boolean;
}) {
  const views: ConnectionsView[] = withGraph ? ['links', 'timeline', 'graph'] : ['links', 'timeline'];
  return (
    <div className="pn-viewswitch" role="group" aria-label="Connections view">
      {views.map((id) => (
        <button
          key={id}
          type="button"
          className={id === view ? 'pn-viewswitch__opt pn-viewswitch__opt--on' : 'pn-viewswitch__opt'}
          aria-pressed={id === view}
          onClick={() => onChange(id)}
        >
          {VIEW_LABEL[id]}
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
 * one fact, so they belong behind one switch. The lists are the PRECISE
 * readings (every peer, every relation type, named); the graph is the SHAPE
 * (what clusters, what sits two hops out, what is a hub).
 *
 * Making it a VIEW rather than a per-kind chip is what makes a task-wise graph
 * cost nothing: `graphSurfaceFor` is already passed to this panel by all five
 * hosts, so every kind gains it in one place instead of fifteen.
 */
/**
 * THREE READINGS OF ONE FACT (task 01a115b8). The switch reads
 * Links | Timeline | Graph:
 *
 *   · LINKS, the default — grouped by what each relation is for, blockers
 *     first, bookkeeping folded last. The question most readers open it with is
 *     "what is this connected to, and what of it matters", and a history
 *     answers that only after the reader has sorted it in their head.
 *   · TIMELINE — the history above, kept whole: newest first, day labels,
 *     clock on every row, narrowed by family.
 *   · GRAPH — the shape, when the host passes a surface.
 *
 * Links and Timeline need no seam and cannot fail, so they are always offered;
 * Graph only where a host can draw it.
 */
export function ConnectionsTab({
  detail,
  connections,
  onOpenEntity,
  graph,
  launchContext,
  header,
  crossSpaceRefs,
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
  /** The ego-network canvas for THIS entity. Absent ⇒ no Graph view is offered. */
  graph?: ReactNode;
  /**
   * A session's LAUNCH CONTEXT section — every selection that went into its
   * launch. Host-composed; absent for other kinds. Drawn BELOW the links: on a
   * session it is long, and above them it pushed every link below the fold.
   */
  launchContext?: ReactNode;
  /**
   * The entity's SELECTION HEADER section (I9a) — what a launch reads when
   * deciding whether to pick this entity. Host-composed; absent for kinds that
   * cannot carry an authored header.
   */
  header?: ReactNode;
  /**
   * The entity's references into other spaces (279): not edges, so drawn as
   * their own section after the peers. Host-composed; renders nothing when
   * there are none.
   */
  crossSpaceRefs?: ReactNode;
}) {
  const [view, setView] = useState<ConnectionsView>('links');
  const [compact, setCompact] = useState(false);
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [showSessions, setShowSessions] = useState(false);
  /* The list's row cursor (task 01a11567): focus lands on the list by script
     (`t l`), then j/k move and Enter opens. Declared above the graph arm's
     early return because a hook must run on every render. */
  const listRef = useRef<HTMLUListElement>(null);
  const cursor = useLinksCursor(listRef, (id) => onOpenEntity?.(id));
  const groups: EdgeGroup[] = [
    ...(connections?.outgoing ?? detail.connections.outgoing),
    ...(connections?.incoming ?? detail.connections.incoming),
  ];
  const peers = groupByPeer(groups, detail.id);
  const conversation = conversationOf(groups, detail.id);
  const parent = detail.hierarchy.parent;
  const children = detail.hierarchy.children.items;
  // Counted, never listed: a credential's sessions are its gated usage read.
  const counted = groups.filter((group) => group.summary !== undefined && group.summary.count > 0);
  const empty = !parent && children.length === 0 && peers.length === 0 && conversation.total === 0 && counted.length === 0;
  /* A filter whose family has since gone (the links changed under it) would
     draw an empty list with no way to see why; it reads as All instead. */
  const activeFilter: TimelineFilter =
    filter !== 'all' && peers.some((p) => p.primary.family === filter) ? filter : 'all';
  const shownView: ConnectionsView = view === 'graph' && graph === undefined ? 'links' : view;

  const toolbar =
    peers.length > 0 || graph !== undefined ? (
      <div className="pn-linkbar">
        <ConnectionsViewSwitch view={shownView} onChange={setView} withGraph={graph !== undefined} />
        {shownView === 'links' && peers.length > 0 ? (
          <button
            type="button"
            className="pn-linkbar__toggle"
            aria-pressed={compact}
            title="One line per link"
            onClick={() => setCompact((c) => !c)}
          >
            Compact
          </button>
        ) : null}
      </div>
    ) : null;

  if (shownView === 'graph') {
    return (
      <div
        className="pn-body pn-body--graph"
        id="tabpanel-connections"
        role="tabpanel"
        aria-labelledby="tab-connections"
      >
        {toolbar}
        <div className="pn-connections-graph">{graph}</div>
      </div>
    );
  }

  return (
    <div
      className={compact && shownView === 'links' ? 'pn-body pn-body--links pn-body--compact' : 'pn-body pn-body--links'}
      id="tabpanel-connections"
      role="tabpanel"
      aria-labelledby="tab-connections"
      data-view={shownView}
    >
      {toolbar}
      {empty ? (
        <EmptyBody
          glyph="⊕"
          sentence="Nothing linked yet — drag an entity here, or press / and type its name."
          actionLabel="⊕ link an entity"
        />
      ) : null}

      {shownView === 'links' && peers.length > 0 && !compact ? (
        <LinksStats peers={peers} messages={conversation.total} />
      ) : null}
      {shownView === 'timeline' ? (
        <>
          <BlockedBanner peers={peers} onOpenEntity={onOpenEntity} />
          <TimelineFilters peers={peers} filter={activeFilter} onChange={setFilter} />
        </>
      ) : null}

      {/* WHERE IT LIVES, on one line above what it links to. */}
      {parent ? (
        <div className="pn-lives">
          <span className="pn-lives__in">In</span>
          <div className="pn-chiprow">
            <Chip
              glyph={<KindIcon kind={parent.kind} size={16} />}
              kind={parent.kind}
              onClick={() => onOpenEntity?.(parent.id)}
              title={peerTitle(parent.kind, parent.title)}
            >
              {parent.title}
            </Chip>
          </div>
          {children.length > 0 ? (
            <span className="pn-lives__more">{`· ${children.length} ${children.length === 1 ? 'child' : 'children'} below`}</span>
          ) : null}
        </div>
      ) : null}

      {counted.map((group) => (
        <section className="pn-section" key={`${group.direction}:${group.type}`} data-testid="pn-counted-group">
          <Eyebrow faint>{`${edgeVerb(group.type, group.direction).toUpperCase()} · ${group.summary!.count}`}</Eyebrow>
          <p className="pn-muted">Listed in this credential&apos;s usage, which its owner and space admins can open.</p>
        </section>
      ))}

      {peers.length > 0 ? (
        /* ONE LIST FOR BOTH READINGS, so `t l` lands on whichever is showing
           and j/k walk its rows. Focusable by script only; Tab order is
           unchanged — every chip and section header is still a button in it. */
        <ul
          className={`pn-peers pn-peers--${shownView}`}
          ref={listRef}
          tabIndex={-1}
          data-testid="pn-peers-list"
          aria-label="Linked entities — j/k to move, Enter to open, Esc to leave"
          aria-keyshortcuts="T L"
          onFocus={cursor.onFocus}
          onBlur={cursor.onBlur}
          onKeyDown={cursor.onKeyDown}
        >
          {shownView === 'links' ? (
            <LinksGrouped peers={peers} compact={compact} selfKind={detail.kind} onOpenEntity={onOpenEntity} />
          ) : (
            <TimelineRows
              peers={peers}
              filter={activeFilter}
              showSessions={showSessions}
              onShowSessions={() => setShowSessions(true)}
              onOpenEntity={onOpenEntity}
            />
          )}
        </ul>
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
                glyph={<KindIcon kind={c.kind} size={16} />}
                kind={c.kind}
                onClick={() => onOpenEntity?.(c.id)}
                title={peerTitle(c.kind, c.title)}
              >
                {c.title}
              </Chip>
            ))}
          </div>
        </section>
      ) : null}

      {crossSpaceRefs}
      {launchContext}
      {header}
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
