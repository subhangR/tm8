/**
 * THE LINKS TAB'S TWO LIST READINGS (task 01a115b8).
 *
 *   · LINKS — grouped by what the relation is FOR: Blocking at the top when
 *     something blocks, then Work, Code, Files & docs, People, and last,
 *     folded, Sessions & provenance. Answers "what is this connected to, and
 *     which of it matters".
 *   · TIMELINE — the same peers newest first under day labels, on a rail whose
 *     dots carry the family colour, narrowed by family chips. Answers "what
 *     happened, and when".
 *
 * Both draw ONE row per peer from the same `PeerGroup`s (`linksModel`), every
 * row a `[data-peer-id]` inside the one list `t l` focuses, so j/k/Enter walk
 * whichever reading is showing. A folded section or a filtered-out family draws
 * no rows, so the cursor never lands on something the reader cannot see.
 */
import { Fragment, useState } from 'react';
import { Avatar, Chip } from '../../kit';
import { absTime, clockTime, relTime } from '../../kit/time';
import { EDGE_FAMILY_LABEL, EDGE_FAMILY_ORDER, KindIcon, getKind, type EdgeFamily } from '../../domain';
import {
  forgeFact,
  linksSections,
  newestRelationInstant,
  peerStatus,
  peerWhenClause,
  whenClause,
  withDayDividers,
  type LinksSection,
  type PeerGroup,
  type Relation,
} from './linksModel';

/**
 * "Task · Fix the login bug" — the kind NAMED, on the hover of every chip in
 * this tab. The drawn mark is the first-glance answer to "which are what"; the
 * word is the second half, for the reader who has not yet learned the mark.
 */
export function peerTitle(kind: string, title: string): string {
  return `${getKind(kind).label} · ${title}`;
}

/** A section opens with more rows than this folds the rest behind "Show N more". */
const SECTION_CAP = 8;

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/**
 * The row's instant, as a real `<time>` — the machine-readable instant travels
 * with the label and the full local date and time is on inspect. The Timeline
 * shows the CLOCK (the day is on the label above it); the Links view, which has
 * no day labels, shows how long ago. Renders nothing for an undated peer.
 */
function PeerWhen({ entry, clock }: { entry: PeerGroup; clock: boolean }) {
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
      {clock ? clockTime(at) : relTime(at)}
    </time>
  );
}

function RelationPill({ rel }: { rel: Relation }) {
  const cls = ['pn-peers__rel'];
  if (rel.unresolvedHard) cls.push('pn-peers__rel--hard');
  else if (rel.resolvedHard) cls.push('pn-peers__rel--met');
  if (rel.ended) cls.push('pn-peers__rel--ended');
  const note = rel.resolvedHard ? ' · resolved' : rel.ended ? ' · ended' : '';
  return (
    <span
      className={cls.join(' ')}
      title={rel.unresolvedHard ? 'unresolved hard dependency' : `${rel.verb}${note}${whenClause(rel.since, rel.changed)}`}
    >
      {/* The verb carries the direction ("Depends on" and "Needed by" are one
          edge type read from its two ends), so no arrow is drawn. */}
      {rel.verb}
      {rel.count > 1 ? ` · ${rel.count}` : ''}
    </span>
  );
}

/** Who made the link — the oldest edge of the relation the row is filed under. */
function LinkedBy({ entry }: { entry: PeerGroup }) {
  const by = entry.primary.by;
  if (!by) return null;
  return (
    <span className="pn-link__by" title={`Linked by ${by.displayName}`}>
      <Avatar actorId={by.id} provenance={by.isAgent ? 'agent' : 'human'} label={by.displayName} size={15} />
      <span className="pn-link__by-name">{by.displayName}</span>
    </span>
  );
}

function StatusPill({ entry }: { entry: PeerGroup }) {
  const status = peerStatus(entry.peer);
  if (!status) return <span className="pn-link__status" />;
  return (
    <span className="pn-link__status">
      <span className="pn-status" data-tone={status.tone}>
        {status.label}
      </span>
    </span>
  );
}

/**
 * ONE PEER. The whole row opens it: the chip is the row's title and its Tab
 * stop, and its click bubbles to the row's one handler, so the verbs, the
 * status and the padding are all a target too.
 *
 * `relations` is what the second line names. The Links view leaves out the
 * relation its sub-heading already says (unless it is the blocker, whose pill
 * is the reason the row is red); the Timeline names them all.
 */
function PeerRow({
  entry,
  relations,
  timeline,
  onOpenEntity,
}: {
  entry: PeerGroup;
  relations: readonly Relation[];
  timeline: boolean;
  onOpenEntity?: (id: string) => void;
}) {
  const fact = forgeFact(entry.peer);
  const met = !entry.unresolvedHard && entry.relations.every((r) => r.resolvedHard || r.ended);
  return (
    <li
      className={met ? 'pn-peers__row pn-link pn-link--settled' : 'pn-peers__row pn-link'}
      data-peer-id={entry.peer.id}
      data-peer-kind={entry.peer.kind}
      data-family={entry.unresolvedHard ? 'block' : entry.primary.family}
      onClick={() => onOpenEntity?.(entry.peer.id)}
    >
      {timeline ? <PeerWhen entry={entry} clock /> : null}
      <Chip
        glyph={<KindIcon kind={entry.peer.kind} size={18} />}
        kind={entry.peer.kind}
        /* An unresolved HARD dependency is why something is blocked — the chip
           says so rather than looking like any other link. */
        title={entry.unresolvedHard ? 'unresolved hard dependency' : peerTitle(entry.peer.kind, entry.peer.title)}
      >
        <span className="pn-peers__title">{entry.peer.title}</span>
      </Chip>
      <div className="pn-peers__meta">
        <span className="pn-peers__kind">{getKind(entry.peer.kind).label}</span>
        {relations.length > 0 ? (
          <span className="pn-peers__rels">
            {relations.map((rel) => (
              <RelationPill rel={rel} key={rel.key} />
            ))}
          </span>
        ) : null}
        {fact ? <span className="pn-link__fact">{fact}</span> : null}
        {timeline && entry.primary.by ? (
          <span className="pn-link__fact">{`by ${entry.primary.by.displayName}`}</span>
        ) : null}
      </div>
      <StatusPill entry={entry} />
      {timeline ? null : (
        <span className="pn-link__end">
          <LinkedBy entry={entry} />
          <PeerWhen entry={entry} clock={false} />
        </span>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// LINKS — grouped by family
// ---------------------------------------------------------------------------

const SECTION_LABEL: Record<LinksSection['id'], string> = { blocking: 'Blocking', ...EDGE_FAMILY_LABEL };

/** What a folded section says about itself, so folding it hides nothing silently. */
function foldedHint(section: LinksSection): string {
  return section.byRelation.map((sub) => `${sub.verb} ${sub.peers.length}`).join(' · ');
}

function Section({
  section,
  open,
  onToggle,
  compact,
  selfKind,
  onOpenEntity,
}: {
  section: LinksSection;
  open: boolean;
  onToggle: () => void;
  compact: boolean;
  selfKind: string;
  onOpenEntity?: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const blocking = section.id === 'blocking';
  const label = SECTION_LABEL[section.id];
  const hint = blocking
    ? `This ${getKind(selfKind).label.toLowerCase()} can’t finish until ${section.peers.length === 1 ? 'this does' : 'these do'}`
    : open
      ? null
      : foldedHint(section);
  /* The cap runs across the sub-groups in order, so "Show N more" always means
     the N rows below the last one drawn. */
  let budget = showAll || section.peers.length <= SECTION_CAP + 2 ? Number.POSITIVE_INFINITY : SECTION_CAP;
  const hidden = Number.isFinite(budget) ? section.peers.length - SECTION_CAP : 0;
  return (
    <li className="pn-linkgroup" data-section={section.id} data-open={open} data-testid="pn-link-section">
      <button type="button" className="pn-linkgroup__head" aria-expanded={open} onClick={onToggle}>
        <span className="pn-linkgroup__chev" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        {blocking ? null : <span className="pn-linkgroup__dot" aria-hidden />}
        <span className="pn-linkgroup__name">{label}</span>
        <span className="pn-linkgroup__count">{section.peers.length}</span>
        {hint ? <span className="pn-linkgroup__hint">{hint}</span> : null}
      </button>
      {open ? (
        <ul className={section.id === 'people' && !compact ? 'pn-linkgroup__rows pn-linkgroup__rows--tiles' : 'pn-linkgroup__rows'}>
          {section.byRelation.map((sub) => {
            if (budget <= 0) return null;
            const peers = sub.peers.slice(0, budget);
            budget -= peers.length;
            return (
              <Fragment key={sub.key}>
                {/* Blocking needs no sub-heading: its one relation is its title. */}
                {blocking ? null : (
                  <li className="pn-linkgroup__sub" aria-hidden>
                    {sub.verb}
                  </li>
                )}
                {peers.map((entry) => (
                  <PeerRow
                    key={entry.peer.id}
                    entry={entry}
                    relations={entry.relations.filter((rel) => rel.unresolvedHard || rel.key !== entry.primary.key)}
                    timeline={false}
                    onOpenEntity={onOpenEntity}
                  />
                ))}
              </Fragment>
            );
          })}
          {hidden > 0 ? (
            <li className="pn-linkgroup__more-row">
              <button type="button" className="pn-linkgroup__more" onClick={() => setShowAll(true)}>
                {`Show ${hidden} more`}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Sessions & provenance starts folded — it is the system's bookkeeping, and on
 * a busy entity it is most of the rows — unless it is ALL there is, when
 * folding it would draw an empty-looking tab over real links.
 */
export function LinksGrouped({
  peers,
  compact,
  selfKind,
  onOpenEntity,
}: {
  peers: readonly PeerGroup[];
  compact: boolean;
  selfKind: string;
  onOpenEntity?: (id: string) => void;
}) {
  const sections = linksSections(peers);
  const onlySessions = sections.every((s) => s.id === 'sessions');
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const foldedByDefault = (id: string) => id === 'sessions' && !onlySessions;
  const isOpen = (id: string) => foldedByDefault(id) === toggled.has(id);
  const toggle = (id: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      {sections.map((section) => (
        <Section
          key={section.id}
          section={section}
          open={isOpen(section.id)}
          onToggle={() => toggle(section.id)}
          compact={compact}
          selfKind={selfKind}
          onOpenEntity={onOpenEntity}
        />
      ))}
    </>
  );
}

/** The tiles above the Links view: what is linked, counted the way a reader asks. */
export function LinksStats({ peers, messages }: { peers: readonly PeerGroup[]; messages: number }) {
  const blocking = peers.filter((p) => p.unresolvedHard).length;
  const prs = peers.filter((p) => p.peer.kind === 'pull_request');
  const openPrs = prs.filter((p) => peerStatus(p.peer)?.label === 'open').length;
  const files = peers.filter((p) => !p.unresolvedHard && p.primary.family === 'files').length;
  const tiles: { key: string; n: number; label: string; alert?: boolean }[] = [];
  if (blocking > 0) tiles.push({ key: 'blocking', n: blocking, label: 'blocking', alert: true });
  tiles.push({ key: 'links', n: peers.length, label: peers.length === 1 ? 'link' : 'links' });
  if (prs.length > 0) {
    tiles.push({ key: 'prs', n: prs.length, label: `${prs.length === 1 ? 'PR' : 'PRs'}${openPrs > 0 ? ` · ${openPrs} open` : ''}` });
  }
  if (files > 0) tiles.push({ key: 'files', n: files, label: 'files & docs' });
  if (messages > 0) tiles.push({ key: 'messages', n: messages, label: messages === 1 ? 'message' : 'messages' });
  return (
    <div className="pn-linkstats" data-testid="pn-link-stats">
      {tiles.map((tile) => (
        <span className={tile.alert ? 'pn-linkstat pn-linkstat--alert' : 'pn-linkstat'} key={tile.key}>
          <b>{tile.n}</b> <span>{tile.label}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TIMELINE — newest first, filtered by family
// ---------------------------------------------------------------------------

export type TimelineFilter = 'all' | EdgeFamily;

function familyOf(entry: PeerGroup): EdgeFamily {
  return entry.primary.family;
}

/** "Blocked by N" — the one fact the Timeline must not bury in its history. */
export function BlockedBanner({
  peers,
  onOpenEntity,
}: {
  peers: readonly PeerGroup[];
  onOpenEntity?: (id: string) => void;
}) {
  const blockers = peers.filter((p) => p.unresolvedHard);
  const first = blockers[0];
  if (!first) return null;
  const status = peerStatus(first.peer);
  return (
    <div className="pn-blocked" role="status" data-testid="pn-blocked">
      <b>{`Blocked by ${blockers.length}`}</b>
      <span className="pn-blocked__title">{first.peer.title}</span>
      {status ? (
        <span className="pn-status" data-tone={status.tone}>
          {status.label}
        </span>
      ) : null}
      {blockers.length > 1 ? <span className="pn-blocked__more">{`+${blockers.length - 1} more`}</span> : null}
      {onOpenEntity ? (
        <button type="button" className="pn-blocked__open" onClick={() => onOpenEntity(first.peer.id)}>
          Open →
        </button>
      ) : null}
    </div>
  );
}

export function TimelineFilters({
  peers,
  filter,
  onChange,
}: {
  peers: readonly PeerGroup[];
  filter: TimelineFilter;
  onChange: (next: TimelineFilter) => void;
}) {
  const counts = new Map<EdgeFamily, number>();
  for (const entry of peers) counts.set(familyOf(entry), (counts.get(familyOf(entry)) ?? 0) + 1);
  const families = EDGE_FAMILY_ORDER.filter((family) => (counts.get(family) ?? 0) > 0);
  /* One family is no choice at all — the chips would filter nothing. */
  if (families.length < 2) return null;
  const chip = (id: TimelineFilter, label: string, n: number) => (
    <button
      type="button"
      key={id}
      className="pn-linkfilter"
      data-family={id}
      aria-pressed={filter === id}
      onClick={() => onChange(id)}
    >
      {id === 'all' ? null : <i aria-hidden />}
      {label}
      <em>{n}</em>
    </button>
  );
  return (
    <div className="pn-linkfilters" role="group" aria-label="Show links of one kind">
      {chip('all', 'All', peers.length)}
      {families.map((family) => chip(family, family === 'sessions' ? 'Sessions' : EDGE_FAMILY_LABEL[family], counts.get(family)!))}
    </div>
  );
}

/**
 * The rows of the Timeline. Under "All", session and provenance links fold into
 * one line at the foot — they are most of a busy entity's history and the least
 * of what a reader came for — unless they are all there is.
 */
export function TimelineRows({
  peers,
  filter,
  showSessions,
  onShowSessions,
  onOpenEntity,
}: {
  peers: readonly PeerGroup[];
  filter: TimelineFilter;
  showSessions: boolean;
  onShowSessions: () => void;
  onOpenEntity?: (id: string) => void;
}) {
  const sessions = peers.filter((p) => familyOf(p) === 'sessions');
  const fold = filter === 'all' && !showSessions && sessions.length > 0 && sessions.length < peers.length;
  const shown = peers.filter((p) =>
    filter === 'all' ? !(fold && familyOf(p) === 'sessions') : familyOf(p) === filter,
  );
  return (
    <>
      {withDayDividers(shown).map((entry) => (
        <Fragment key={entry.peer.id}>
          {entry.dayLabel ? (
            /* The day said ONCE over the run it covers; each row below it needs
               only its clock. Same grammar as the channel feed. */
            <li className="pn-peers__day" data-testid="pn-peers-day">
              <span className="pn-peers__day-label">{entry.dayLabel}</span>
            </li>
          ) : null}
          <PeerRow entry={entry} relations={entry.relations} timeline onOpenEntity={onOpenEntity} />
        </Fragment>
      ))}
      {fold ? (
        <li className="pn-timeline__folded">
          <span>
            <b>{`+ ${sessions.length} session & provenance ${sessions.length === 1 ? 'link' : 'links'}`}</b>
            {' — who worked on it, where it was made'}
          </span>
          <button type="button" className="pn-linkgroup__more" onClick={onShowSessions}>
            Show
          </button>
        </li>
      ) : null}
    </>
  );
}
