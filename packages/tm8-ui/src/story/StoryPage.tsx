/**
 * THE STORY PAGE — the shell every story block mounts in (artifact 01a0fc3e
 * rev 4, top to bottom): the bar (breadcrumb + kind chip), the HERO, the FOUR
 * STATS, the graph, the team, the roots, the child stories, then the live feed
 * and what's happening beside the rail, and the playground floating over all
 * of it.
 *
 * The shell owns exactly one piece of shared state: the node PICK. Any block
 * that draws a node reports a click through `onPick`; the playground renders
 * the popover for it. Everything else is block-local.
 *
 * Every figure here is the server's (`view.state`) — the shell reads, it never
 * tallies. The one thing it counts is the by-kind breakdown under "In the
 * story", which is a label over `page.nodes`, not a progress figure.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { StatusCategory } from '@tm8/contract';

import { Avatar, Pill, VectorIcon, relTime, type PillTone } from '../kit';
import { KIND_ART } from '../domain/kind-art';
import { getKind } from '../domain/registry';
import { ChildStoriesCard } from './cards/ChildStoriesCard';
import { LiveFeed } from './cards/LiveFeed';
import { RootsCard } from './cards/RootsCard';
import { StoryRail } from './cards/StoryRail';
import { TeamCard } from './cards/TeamCard';
import { WhatsHappening } from './cards/WhatsHappening';
import { StoryGraph } from './graph/StoryGraph';
import { StoryPlayground } from './playground/StoryPlayground';
import {
  STORY_KIND,
  TONE_WORD,
  liveOn,
  pct,
  segments,
  statusWord,
  teammatesOf,
  type StoryGraphView,
  type StoryTone,
  type StoryView,
} from './model';
import type { StoryBlockProps, StoryGraphFilter, StoryHops, StoryLive, StoryNodePick } from './props';
import './story-page.css';

/** The status pill's tone per category (status is always colour + word). */
const CATEGORY_TONE: Readonly<Record<StatusCategory, PillTone>> = {
  to_do: 'idle',
  in_progress: 'info',
  done: 'run',
  cancelled: 'idle',
};

/** The meter's segment order and colour token per tone (to do is the track). */
const METER: ReadonlyArray<{ tone: StoryTone; token: string }> = [
  { tone: 'done', token: 'var(--pn-run)' },
  { tone: 'working', token: 'var(--pn-info)' },
  { tone: 'blocked', token: 'var(--pn-block)' },
  { tone: 'todo', token: 'var(--pn-line-2)' },
];

const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Where the graph filter lives when the host can address it (PR 1004): the
 * entity route's `?hops` / `?kinds`. Absent ⇒ the page keeps it locally.
 */
export interface StoryFilterRoute {
  hops: StoryHops | null;
  kinds: readonly string[] | null;
  set: (hops: StoryHops | null, kinds: readonly string[] | null) => void;
}

export interface StoryPageProps extends StoryBlockProps {
  initialGraphView?: StoryGraphView;
  /** The route-backed filter; absent ⇒ local state. */
  filterRoute?: StoryFilterRoute | null;
  /**
   * `full` = the Z4 full view: the rail sits beside the main column and the
   * graph takes a tall, definite box (StoryGraph `fill`). Default `panel`.
   */
  layout?: 'panel' | 'full';
}

export function StoryPage({
  view,
  actions,
  live,
  runners,
  initialGraphView,
  selectedId,
  filterRoute,
  layout = 'panel',
}: StoryPageProps) {
  /* THE MENU PICK IS NOT THE SELECTION (PR 1004). Selection is the entity
     whose detail panel is open beside the story — the HOST's state, handed in
     as `selectedId`, so closing that panel clears it. The menu pick is only
     the action popover's anchor; the popover closing never touches the
     selection, and a right-click never drops it. */
  const [menuPick, setMenuPick] = useState<StoryNodePick | null>(null);
  // Stable: the popover's outside-pointerdown listener depends on it.
  const closeMenu = useCallback(() => setMenuPick(null), []);
  // A pick names a node of THIS story; a different story drops it.
  useEffect(() => setMenuPick(null), [view.id]);
  const [hoverRootId, setHoverRootId] = useState<string | null>(null);
  const hover = useMemo(() => ({ rootId: hoverRootId, setRootId: setHoverRootId }), [hoverRootId]);

  /* PRIMARY press opens the entity's details BESIDE the story: the host's
     `open` port is the beside opener (the kind screen's aux column, the
     workspace's next panel, the full view's right slot). No port ⇒ nothing
     to open, and the blocks draw no press affordance beyond the menu. */
  const open = actions.open;
  const onPick = useCallback((pick: StoryNodePick) => open?.(pick.entityId), [open]);

  const filter = useStoryFilter(view.id, filterRoute ?? null);

  const block = {
    view,
    actions,
    live,
    hover,
    selectedId: selectedId ?? null,
    filter,
    onMenu: setMenuPick,
    ...(open ? { onPick } : {}),
  };
  const full = layout === 'full';
  const graph = (
    <StoryGraph {...block} {...(initialGraphView ? { initialView: initialGraphView } : {})} {...(full ? { fill: true } : {})} />
  );

  return (
    <div
      className={`sty-page${full ? ' sty-page--full' : ''}`}
      data-testid="story-page"
      data-story-root=""
      data-story-id={view.id}
    >
      <StoryBar view={view} open={actions.open} />
      <StoryHero view={view} rename={actions.rename} live={live ?? null} />
      <StoryStats view={view} />
      {filter.hops < 3 ? (
        <p className="sty-hopsnote" role="status">
          showing {plural(filter.hops, 'hop')} from the roots · the figures above are the whole story
        </p>
      ) : null}
      {full ? (
        /* FULL VIEW: the rail beside the main column, the graph in a tall
           definite box so `fill` can grow it. */
        <section className="sty-full">
          <div className="sty-full__main">
            <div className="sty-graphbox">{graph}</div>
            <TeamCard {...block} />
            <RootsCard {...block} />
            <ChildStoriesCard {...block} />
            <LiveFeed {...block} />
            <WhatsHappening {...block} />
          </div>
          <aside className="sty-full__rail">
            <StoryRail {...block} />
          </aside>
        </section>
      ) : (
        <>
          {graph}
          <TeamCard {...block} />
          <RootsCard {...block} />
          <ChildStoriesCard {...block} />
          <section className="sty-cols">
            <div className="sty-cols__main">
              <LiveFeed {...block} />
              <WhatsHappening {...block} />
            </div>
            <aside className="sty-cols__rail">
              <StoryRail {...block} />
            </aside>
          </section>
        </>
      )}
      <StoryPlayground
        view={view}
        actions={actions}
        live={live}
        pick={menuPick}
        onClosePick={closeMenu}
        runners={runners ?? null}
      />
    </div>
  );
}

/**
 * The graph filter (hops + kinds), from the route when the host addresses it
 * and local otherwise. View only: the server's figures never move with it.
 */
function useStoryFilter(storyId: string, route: StoryFilterRoute | null): StoryGraphFilter {
  const [localHops, setLocalHops] = useState<StoryHops>(3);
  const [localKinds, setLocalKinds] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    setLocalHops(3);
    setLocalKinds(null);
  }, [storyId]);
  const routeKinds = route?.kinds ?? null;
  const routeKindsKey = routeKinds ? routeKinds.join(',') : null;
  const kindsFromRoute = useMemo(
    () => (routeKindsKey === null ? null : new Set(routeKindsKey.split(',').filter(Boolean))),
    [routeKindsKey],
  );
  const hops: StoryHops = route ? (route.hops ?? 3) : localHops;
  const kinds = route ? kindsFromRoute : localKinds;
  const set = route?.set;
  return useMemo<StoryGraphFilter>(
    () => ({
      hops,
      kinds,
      setHops: (next) => {
        if (set) set(next === 3 ? null : next, kinds ? [...kinds] : null);
        else setLocalHops(next);
      },
      setKinds: (next) => {
        if (set) set(hops === 3 ? null : hops, next ? [...next] : null);
        else setLocalKinds(next);
      },
    }),
    [hops, kinds, set],
  );
}

/* ------------------------------------------------------------------------- */

function StoryBar({ view, open }: { view: StoryView; open?: (id: string) => void }) {
  const parent = view.page.parent;
  return (
    <div className="sty-bar">
      <span className="sty-bar__crumb">
        <VectorIcon paths={KIND_ART.story} size={14} />
        <span>{getKind(STORY_KIND).labelPlural}</span>
        {parent ? (
          <>
            <span className="sty-bar__sep">/</span>
            {open ? (
              <button type="button" className="sty-bar__link" title="the parent story" onClick={() => open(parent.id)}>
                {parent.title}
              </button>
            ) : (
              <span title="the parent story">{parent.title}</span>
            )}
          </>
        ) : null}
        <span className="sty-bar__sep">/</span>
        <b>{view.title}</b>
      </span>
      <span className="sty-kindchip">
        <VectorIcon paths={KIND_ART.story} size={12} />
        {getKind(STORY_KIND).label}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function StoryHero({
  view,
  rename,
  live,
}: {
  view: StoryView;
  rename?: (entityId: string, title: string) => Promise<void>;
  live: StoryLive | null;
}) {
  const { state, page } = view;
  const kids = state.childStoryCount;
  const tone = view.statusCategory ? CATEGORY_TONE[view.statusCategory] : 'idle';
  // The status key, else its category in words; a read with neither draws none.
  const statusLabel = statusWord(view.status) || statusWord(view.statusCategory);

  const teammates = teammatesOf(page);
  const members = Object.values(view.people).filter((p) => !p.agent);
  const onIt = members.length + teammates.length;

  return (
    <section
      className="sty-hero"
      data-landed={live?.landed.has(view.id) ? 'true' : undefined}
      style={{ ['--sty-p' as string]: `${pct(state.taskProgress)}%` }}
    >
      <StoryTitle id={view.id} title={view.title} rename={rename} />
      <StoryLede text={view.description} />

      {/* ONE line under the title: what the kicker and the meta row used to
          say on two (Subhang, PR 1004: the top took ~650px). Wraps on a
          narrow panel; nothing is dropped, only folded. */}
      <div className="sty-herometa">
        {statusLabel ? (
          <Pill tone={tone} dot="solid">
            {statusLabel}
          </Pill>
        ) : null}
        <span>{plural(state.rootCount, 'root')}</span>
        {kids > 0 ? <span>{plural(kids, 'child story', 'child stories')}</span> : null}
        <span>{plural(state.itemCount, 'thing')} in it</span>
        {onIt > 0 ? (
          <span className="sty-who" title={`${teammates.length} teammates · ${members.length} members`}>
            <span className="sty-stack">
              {members.map((m) => (
                <Avatar key={m.id} actorId={m.id} provenance="human" label={m.name} initials={m.initials} size={15} />
              ))}
              {teammates.map((t) => (
                <Avatar
                  key={t.id}
                  actorId={t.id}
                  provenance="agent"
                  label={t.live ? `${t.name} · live` : t.name}
                  initials={view.people[t.id]?.initials}
                  size={15}
                  className={t.live ? 'sty-av--live' : undefined}
                />
              ))}
            </span>
            {onIt} on it
          </span>
        ) : null}
        {live ? <LivePill live={live} /> : null}
        {view.feed.length > 0 ? (
          <span className="sty-who">
            <VectorIcon paths={KIND_ART.message} size={13} />
            {view.feed.length}
            {view.feed.length >= 50 ? '+' : ''} messages
          </span>
        ) : null}
        {state.pendingAttentionCount > 0 ? (
          <Pill tone="wait" dot="solid">
            {plural(state.pendingAttentionCount, 'attention request')}
          </Pill>
        ) : null}
        {state.lastActivityAt ? <span className="sty-herometa__when">active {relTime(state.lastActivityAt)}</span> : null}
      </div>
    </section>
  );
}

/**
 * The description, clamped to two lines with a toggle — drawn only when the
 * clamp actually hides something, so a short description has no dead "more".
 */
function StoryLede({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  if (!text) return <p className="sty-lede sty-lede--empty">No description yet. Put things in and the page fills itself.</p>;
  return (
    <div className="sty-ledebox">
      <p ref={ref} className={`sty-lede${open ? '' : ' sty-lede--clamped'}`}>
        {text}
      </p>
      {clamped || open ? (
        <button type="button" className="sty-lede__more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'less' : 'more'}
        </button>
      ) : null}
    </div>
  );
}

/** Click-to-rename. With no `rename` the title is plain text (no dead control). */
function StoryTitle({ id, title, rename }: { id: string; title: string; rename?: (id: string, title: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (draft !== null) input.current?.select();
    // Select once, when editing opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft === null]);

  if (!rename) return <h1 className="sty-title">{title}</h1>;

  const commit = () => {
    const next = draft?.trim() ?? '';
    if (!next || next === title) {
      setDraft(null);
      return;
    }
    setBusy(true);
    rename(id, next)
      .then(() => {
        setDraft(null);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') {
      setDraft(null);
      setError(null);
    }
  };

  if (draft === null) {
    return (
      <h1 className="sty-title">
        <button type="button" className="sty-title__btn" title="Click to rename" onClick={() => setDraft(title)}>
          {title}
        </button>
      </h1>
    );
  }
  return (
    <div className="sty-title sty-title--editing">
      <input
        ref={input}
        className="sty-title__input"
        aria-label="Story title"
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
      />
      {error ? <div className="sty-title__error" role="alert">{error}</div> : null}
    </div>
  );
}

function LivePill({ live }: { live: StoryLive }) {
  const paused = live.paused;
  const text = paused
    ? `paused · ${live.queued > 0 ? `${live.queued} queued` : 'events queue until you resume'}`
    : live.status === 'reconnecting'
      ? 'reconnecting…'
      : live.updatesLastMinute > 0
        ? `live · ${plural(live.updatesLastMinute, 'update')} in the last minute`
        : 'live · updates as they happen';
  return (
    <button
      type="button"
      className={`sty-livepill${paused || live.status !== 'live' ? ' sty-livepill--paused' : ''}`}
      title={paused ? 'Resume the live feed' : 'Every change in the story lands here as it happens, over the event feed. Click to pause.'}
      aria-pressed={paused}
      onClick={() => live.setPaused(!paused)}
    >
      <i />
      {text}
    </button>
  );
}

/* ------------------------------------------------------------------------- */

function StoryStats({ view }: { view: StoryView }) {
  const { state, page } = view;
  const tp = state.taskProgress;
  const seg = segments(tp);

  const liveSessions = page.sessions.filter((s) => s.live);
  const liveTasks = liveOn(view).size;

  const blockedRoots = page.roots
    .map((r, i) => ({ n: i + 1, blocked: r.taskProgress.blocked }))
    .filter((r) => r.blocked > 0)
    .map((r) => `root ${r.n}`);
  const blockedSub = [
    state.pendingAttentionCount > 0 ? plural(state.pendingAttentionCount, 'attention request') : null,
    blockedRoots.length > 0 ? blockedRoots.join(', ') : null,
  ].filter(Boolean);

  const byKind = new Map<string, number>();
  for (const n of page.nodes) if (n.depth >= 0) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
  const kindLine = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => {
      const row = getKind(kind);
      // A kind with no registry row of its own says its own name, not the
      // fallback row's generic word.
      const word = row.kind === kind ? (n === 1 ? row.label : row.labelPlural) : kind.replace(/_/g, ' ');
      return `${n} ${word.toLowerCase()}`;
    })
    .join(' · ');

  const liveSub =
    liveSessions.length > 0 ? `${liveSessions.map((s) => s.callSign).join(' · ')} on ${plural(liveTasks, 'task')}` : 'nobody is running on it';
  const blockedLine = blockedSub.length > 0 ? blockedSub.join(' · ') : 'nothing is blocked';
  const thingsLine = `${kindLine || 'nothing yet · put a task in to start'}${state.truncated ? ` · first ${page.follow.limit} shown` : ''}`;

  /* ONE slim strip (PR 1004): each figure is number + label inline, its
     detail one truncated line under it (full text on hover). The progress
     cell carries a thin meter and its legend on one line. */
  return (
    <section className="sty-strip" data-testid="story-stats">
      <div className="sty-strip__cell sty-strip__cell--progress">
        <div className="sty-strip__row">
          <div className="sty-strip__v">
            <b>{tp.done}</b> of {plural(tp.work, 'task')} done
          </div>
          <div className="sty-legend">
            {METER.map((m) => (
              <span key={m.tone}>
                <i style={{ background: m.token }} />
                {seg[m.tone]} {TONE_WORD[m.tone]}
              </span>
            ))}
          </div>
          <span className="sty-strip__pct">{pct(tp)}%</span>
        </div>
        <div className="sty-meter" role="img" aria-label={`${tp.done} of ${tp.work} tasks done`}>
          {seg.total > 0
            ? METER.filter((m) => m.tone !== 'todo').map((m) => (
                <b key={m.tone} style={{ width: `${(100 * seg[m.tone]) / seg.total}%`, background: m.token }} />
              ))
            : null}
        </div>
      </div>
      <div className="sty-strip__cell">
        <div className="sty-strip__v">
          {liveSessions.length > 0 ? <i className="sty-strip__pulse" aria-hidden /> : null}
          <b>{state.liveSessionCount}</b> live {state.liveSessionCount === 1 ? 'session' : 'sessions'}
        </div>
        <div className="sty-strip__sub" title={liveSub}>
          {liveSub}
        </div>
      </div>
      <div className="sty-strip__cell">
        <div className="sty-strip__v">
          <b className={tp.blocked > 0 ? 'sty-strip__blocked' : undefined}>{tp.blocked}</b> blocked
        </div>
        <div className="sty-strip__sub" title={blockedLine}>
          {blockedLine}
        </div>
      </div>
      <div className="sty-strip__cell">
        <div className="sty-strip__v">
          <b>{state.itemCount}</b> {state.itemCount === 1 ? 'thing' : 'things'} in it
        </div>
        <div className="sty-strip__sub" title={thingsLine}>
          {thingsLine}
        </div>
      </div>
    </section>
  );
}
