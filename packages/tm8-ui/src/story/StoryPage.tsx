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
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { StatusCategory } from '@tm8/contract';

import { Avatar, Pill, VectorIcon, type PillTone } from '../kit';
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
  since,
  type StoryTone,
  type StoryView,
} from './model';
import type { StoryBlockProps, StoryLive, StoryNodePick } from './props';
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

export function StoryPage({ view, actions, live }: StoryBlockProps) {
  const [pick, setPick] = useState<StoryNodePick | null>(null);
  // A pick names a node of THIS story; a different story drops it.
  useEffect(() => setPick(null), [view.id]);
  const block = { view, actions, live, onPick: setPick };

  return (
    <div className="sty-page" data-testid="story-page" data-story-root="" data-story-id={view.id}>
      <StoryBar view={view} open={actions.open} />
      <StoryHero view={view} rename={actions.rename} live={live ?? null} />
      <StoryStats view={view} />
      <StoryGraph {...block} />
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
      <StoryPlayground view={view} actions={actions} live={live} pick={pick} onClosePick={() => setPick(null)} />
    </div>
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
  const last = since(state.lastActivityAt);
  // The status key, else its category in words; a read with neither draws none.
  const statusWord = view.status || (view.statusCategory ? view.statusCategory.replace('_', ' ') : '');

  const teammates = page.team;
  const members = Object.values(view.people).filter((p) => !p.agent);
  const onIt = members.length + teammates.length;

  return (
    <section
      className="sty-hero"
      data-landed={live?.landed.has(view.id) ? 'true' : undefined}
      style={{ ['--sty-p' as string]: `${pct(state.taskProgress)}%` }}
    >
      <div className="sty-eyebrow">
        <span>{getKind(STORY_KIND).label}</span>
        {statusWord ? (
          <>
            <i className="sty-dot" />
            <span className={`sty-eyebrow__status sty-tone--${tone}`}>{statusWord}</span>
          </>
        ) : null}
        <i className="sty-dot" />
        <span>{plural(state.rootCount, 'root')}</span>
        {kids > 0 ? (
          <>
            <i className="sty-dot" />
            <span>{plural(kids, 'child story', 'child stories')}</span>
          </>
        ) : null}
        <i className="sty-dot" />
        <span>{plural(state.itemCount, 'thing')} in it</span>
        {state.lastActivityAt ? (
          <>
            <i className="sty-dot" />
            <span>last activity {last === 'now' ? 'just now' : /(min|h)$/.test(last) ? `${last} ago` : last}</span>
          </>
        ) : null}
      </div>

      <StoryTitle id={view.id} title={view.title} rename={rename} />
      {view.description ? (
        <p className="sty-lede">{view.description}</p>
      ) : (
        <p className="sty-lede sty-lede--empty">No description yet. Put things in and the page fills itself.</p>
      )}

      <div className="sty-herometa">
        {statusWord ? (
          <Pill tone={tone} dot="solid">
            {statusWord}
          </Pill>
        ) : null}
        {onIt > 0 ? (
          <span className="sty-who">
            <span className="sty-stack">
              {members.map((m) => (
                <Avatar key={m.id} actorId={m.id} provenance="human" label={m.name} initials={m.initials} size={20} />
              ))}
              {teammates.map((t) => (
                <Avatar
                  key={t.id}
                  actorId={t.id}
                  provenance="agent"
                  label={t.live ? `${t.name} · live` : t.name}
                  initials={view.people[t.id]?.initials}
                  size={20}
                  className={t.live ? 'sty-av--live' : undefined}
                />
              ))}
            </span>
            {onIt} on it
            {teammates.length > 0 ? ` · ${plural(teammates.length, 'teammate')}` : ''}
            {members.length > 0 ? ` · ${plural(members.length, 'member')}` : ''}
          </span>
        ) : null}
        {live ? <LivePill live={live} /> : null}
        {view.feed.length > 0 ? (
          <span className="sty-who">
            <VectorIcon paths={KIND_ART.message} size={14} />
            {view.feed.length}
            {view.feed.length >= 50 ? '+' : ''} messages across the story
          </span>
        ) : null}
        {state.pendingAttentionCount > 0 ? (
          <Pill tone="wait" dot="solid">
            {plural(state.pendingAttentionCount, 'attention request')}
          </Pill>
        ) : null}
      </div>
    </section>
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

  return (
    <section className="sty-stats" data-testid="story-stats">
      <div className="sty-stat sty-stat--progress">
        <div className="sty-stat__k">Progress · all roots</div>
        <div className="sty-stat__v">
          {tp.done} <small>of {plural(tp.work, 'task')} done</small>
          <span className="sty-stat__pct">{pct(tp)}%</span>
        </div>
        <div className="sty-meter" role="img" aria-label={`${tp.done} of ${tp.work} tasks done`}>
          {seg.total > 0
            ? METER.filter((m) => m.tone !== 'todo').map((m) => (
                <b key={m.tone} style={{ width: `${(100 * seg[m.tone]) / seg.total}%`, background: m.token }} />
              ))
            : null}
        </div>
        <div className="sty-legend">
          {METER.map((m) => (
            <span key={m.tone}>
              <i style={{ background: m.token }} />
              {seg[m.tone]} {TONE_WORD[m.tone]}
            </span>
          ))}
        </div>
      </div>

      <div className="sty-stat">
        <div className="sty-stat__k">Live now</div>
        <div className="sty-stat__v">
          {state.liveSessionCount} <small>{state.liveSessionCount === 1 ? 'session' : 'sessions'}</small>
        </div>
        <div className="sty-stat__sub">
          {liveSessions.length > 0 ? (
            <>
              <Pill tone="run" dot="pulse">
                {liveSessions.map((s) => s.callSign).join(' · ')}
              </Pill>{' '}
              on {plural(liveTasks, 'task')}
            </>
          ) : (
            'nobody is running on it'
          )}
        </div>
      </div>

      <div className="sty-stat">
        <div className="sty-stat__k">Blocked</div>
        <div className="sty-stat__v">
          {tp.blocked} <small>{tp.blocked === 1 ? 'task' : 'tasks'}</small>
        </div>
        <div className="sty-stat__sub">{blockedSub.length > 0 ? blockedSub.join(' · ') : 'nothing is blocked'}</div>
      </div>

      <div className="sty-stat">
        <div className="sty-stat__k">In the story</div>
        <div className="sty-stat__v">
          {state.itemCount} <small>{state.itemCount === 1 ? 'thing' : 'things'}</small>
        </div>
        <div className="sty-stat__sub">
          {kindLine || 'nothing yet · put a task in to start'}
          {state.truncated ? ` · first ${page.follow.limit} shown` : ''}
        </div>
      </div>
    </section>
  );
}
