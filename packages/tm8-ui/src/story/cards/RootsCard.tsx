/**
 * ROOTS — the things put in by hand, each with its own progress (the server's
 * `taskProgress`), its children by hierarchy, and its trail as chips coloured
 * by edge family. A root a live session runs carries the run chip and the
 * left rail.
 *
 * Pressing a root's title, a child or a trail chip opens its details beside
 * the story (`onPick`); its "…" or a right-click opens the action popover
 * (`onMenu`); the selected one is drawn highlighted. Inline adds: "＋ task
 * under this root" rides `actions.createTask`; the ✎ beside a title renames it
 * through `actions.rename`. A row the live feed just landed flashes.
 *
 * The page's hops filter (`filter.hops`) narrows each trail to items within
 * that many hops of their root, as the graph does; progress stays the
 * server's whole-trail figure either way.
 *
 * Root hover is shared with the graph (`hover`): entering a row lights that
 * root everywhere, and a root lit from the graph lights its row and its trail
 * chips here.
 *
 * "＋ Add a root" is the membership block's own picker (`MembershipPicker`):
 * one bounded recent page from `actions.searchRoots`, put in through
 * `actions.addRoot`. Drawn only when both exist.
 */
import { useState } from 'react';

import { KindIcon } from '../../domain';
import { MembershipPicker } from '../../panels/bodies/MembershipBlock';
import {
  liveOn,
  nodesById,
  pct,
  since,
  TONE_WORD,
  toneOf,
  VIEW_OF_KIND,
  type StoryRoot,
  type StorySession,
  type StoryView,
} from '../model';
import type { StoryBlockProps } from '../props';
import { CardHead, Empty, flashOf, InlineEntry, MenuDot, Meter, PersonAvatar, PressTitle, pressOf, RenamableTitle, TonePill, type Press } from './shared';

export function RootsCard(props: StoryBlockProps) {
  const { view, actions, live, hover } = props;
  /** The server always follows STORY_FOLLOW_DEPTH (3); absent filter = all of it. */
  const hops = props.filter?.hops ?? 3;
  const press = pressOf(props);
  const roots = view.page.roots;
  const { addRoot, searchRoots } = actions;
  return (
    <section className="stc-card">
      <CardHead
        title="Roots"
        count={roots.length ? `${roots.length} · each with its own progress, children and trail · a live root shows who is running it` : undefined}
      />
      {addRoot && searchRoots ? (
        <div className="stc-roots__add">
          <MembershipPicker
            search={searchRoots}
            onPick={(id) => void addRoot(id)}
            excludeIds={new Set([view.id, ...roots.map((r) => r.id)])}
            addLabel="＋ Add a root"
          />
        </div>
      ) : null}
      {roots.length === 0 ? (
        <Empty>Nothing has been put in this story yet. Put a task in and it becomes a root: its children, sessions, docs and pull requests follow along.</Empty>
      ) : (
        roots.map((root, i) => (
          <RootRow key={root.id} root={root} index={i} view={view} actions={actions} live={live} hover={hover} press={press} hops={hops} />
        ))
      )}
    </section>
  );
}

function runnerName(view: StoryView, s: StorySession): string {
  return (s.teamMemberId && view.people[s.teamMemberId]?.name) || s.title;
}

function RootRow({
  root,
  index,
  view,
  actions,
  live,
  hover,
  press,
  hops,
}: StoryBlockProps & { root: StoryRoot; index: number; press: Press; hops: number }) {
  const [adding, setAdding] = useState(false);
  const byId = nodesById(view);
  const running = liveOn(view);
  const run = running.get(root.id);
  const assignee = view.page.team.find((t) => t.assigned.includes(root.id) || t.runs.includes(root.id));
  const p = root.taskProgress;
  const tone = toneOf(root);
  const rename = actions.rename;
  const createTask = actions.createTask;
  const landed = live?.landed;
  const lit = !!hover && hover.rootId === root.id;
  const trail = root.trail.filter((x) => x.depth <= hops);
  const hidden = root.trail.length - trail.length;

  return (
    <div
      className={`stc-root${run ? ' stc-root--live' : ''}${lit ? ' stc-root--lit' : ''}${press.sel(root.id)}${flashOf(landed, root.id)}`}
      onMouseEnter={hover ? () => hover.setRootId(root.id) : undefined}
      onMouseLeave={hover ? () => hover.setRootId(null) : undefined}
    >
      <div>
        <div className="stc-root__hd">
          <KindIcon kind={root.kind} size={16} />
          <div>
            <span className="stc-hit" data-entity={root.id} onContextMenu={press.menu?.(root.id)}>
              <RenamableTitle
                title={root.title}
                rename={rename ? (t) => rename(root.id, t) : undefined}
                menu={<MenuDot id={root.id} label={root.title} press={press} />}
              >
                <PressTitle id={root.id} title={root.title} press={press} className="stc-root__title" />
              </RenamableTitle>
            </span>
            <div className="stc-root__sub">
              <TonePill tone={tone} />
              {run ? (
                <span className="stc-runchip">
                  <PersonAvatar id={run.teamMemberId} person={run.teamMemberId ? view.people[run.teamMemberId] ?? null : null} agent size={15} />
                  <span>
                    {runnerName(view, run)} · {run.callSign}
                  </span>
                  <span className="stc-runchip__lv">● live</span>
                  <span className="stc-m">
                    {since(run.createdAt)}
                    {run.taskIds.length > 1 ? ` · +${run.taskIds.length - 1} task` : ''}
                  </span>
                </span>
              ) : assignee ? (
                <span className="stc-root__who">
                  <PersonAvatar id={assignee.id} person={view.people[assignee.id] ?? null} fallbackName={assignee.name} agent size={15} />
                  {assignee.name}
                </span>
              ) : (
                <span>unassigned</span>
              )}
              <span className="stc-m">root {index + 1}</span>
            </div>
          </div>
        </div>
        <div className="stc-root__bar">
          <Meter progress={p} />
          <span className="stc-root__pct">
            {p.done} of {p.work} · {pct(p)}%
          </span>
        </div>
      </div>

      <div className="stc-tree">
        <div className="stc-lbl">children · {root.childIds.length}</div>
        {root.childIds.map((id) => {
          const c = byId.get(id);
          if (!c) return null;
          const ct = toneOf(c);
          const l = running.get(id);
          return (
            <div
              key={id}
              className={`stc-tree__c stc-tone--${ct ?? 'cancelled'}${press.sel(id)}${flashOf(landed, id)}`}
              data-entity={id}
              onContextMenu={press.menu?.(id)}
            >
              <i className="stc-tree__dot" aria-hidden />
              <RenamableTitle
                title={c.title}
                rename={rename ? (t) => rename(id, t) : undefined}
                menu={<MenuDot id={id} label={c.title} press={press} />}
              >
                <PressTitle id={id} title={c.title} press={press} className="stc-tree__t" />
              </RenamableTitle>
              {l ? (
                <PersonAvatar id={l.teamMemberId} person={l.teamMemberId ? view.people[l.teamMemberId] ?? null : null} agent size={15} live />
              ) : null}
              {c.blocked ? <span className="stc-tree__blk">● blocked</span> : null}
              <span className={l ? 'stc-tree__w stc-tree__w--live' : 'stc-tree__w'}>{l ? `● ${l.callSign} live` : ct ? TONE_WORD[ct] : 'cancelled'}</span>
            </div>
          );
        })}
        {createTask ? (
          adding ? (
            <InlineEntry
              className="stc-tree__entry"
              placeholder="A task under this root"
              onSubmit={(title) => createTask(root.id, title)}
              onClose={() => setAdding(false)}
            />
          ) : (
            <button type="button" className="stc-tree__add" onClick={() => setAdding(true)}>
              ＋ task under this root
            </button>
          )
        ) : null}
      </div>

      <div className="stc-trail">
        <div className="stc-lbl" title={hidden ? `${hidden} further than ${hops} ${hops === 1 ? 'hop' : 'hops'} from the root` : undefined}>
          trail · {hidden ? `${trail.length} of ${root.trail.length}` : root.trail.length}
        </div>
        {root.trail.length === 0 ? (
          <span className="stc-quiet">nothing follows from it yet</span>
        ) : trail.length === 0 ? (
          <span className="stc-quiet">nothing within {hops} {hops === 1 ? 'hop' : 'hops'}</span>
        ) : null}
        {trail.map((x) => {
          const n = byId.get(x.id);
          const exited = n?.live === false;
          const memory = VIEW_OF_KIND[x.kind] === 'memories';
          const cls = `stc-chip stc-fam--${x.family}${exited ? ' stc-chip--exited' : ''}${memory ? ' stc-chip--memory' : ''}${lit ? ' stc-chip--lit' : ''}${press.sel(x.id)}${flashOf(landed, x.id)}`;
          const body = (
            <>
              <KindIcon kind={x.kind} size={14} />
              <span className="stc-chip__t">{x.title}</span>
              <span className="stc-chip__m">{x.edgeType}</span>
            </>
          );
          return (
            <span key={`${x.id}-${x.viaId}`} className={cls} title={x.title} data-entity={x.id} onContextMenu={press.menu?.(x.id)}>
              <PressTitle id={x.id} title={body} press={press} className="stc-chip__press" />
              <MenuDot id={x.id} label={x.title} press={press} />
            </span>
          );
        })}
      </div>
    </div>
  );
}
