/**
 * ROOTS — the things put in by hand, each with its own progress (the server's
 * `taskProgress`), its children by hierarchy, and its trail as chips coloured
 * by edge family. A root a live session runs carries the run chip and the
 * left rail.
 *
 * Inline adds: "＋ task under this root" rides `actions.createTask`; clicking a
 * title renames it through `actions.rename`. A row the live feed just landed
 * flashes (`live.landed`).
 */
import { useState } from 'react';

import { KindIcon } from '../../domain';
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
import type { StoryBlockProps, StoryNodePick } from '../props';
import { CardHead, Empty, flashOf, InlineEntry, Meter, PersonAvatar, picker, RenamableTitle, TonePill } from './shared';

export function RootsCard({ view, actions, live, onPick }: StoryBlockProps & { onPick?: (pick: StoryNodePick) => void }) {
  const roots = view.page.roots;
  return (
    <section className="stc-card">
      <CardHead
        title="Roots"
        count={roots.length ? `${roots.length} · each with its own progress, children and trail · a live root shows who is running it` : undefined}
      />
      {roots.length === 0 ? (
        <Empty>Nothing has been put in this story yet. Put a task in and it becomes a root: its children, sessions, docs and pull requests follow along.</Empty>
      ) : (
        roots.map((root, i) => (
          <RootRow key={root.id} root={root} index={i} view={view} actions={actions} live={live} onPick={onPick} />
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
  onPick,
}: StoryBlockProps & { root: StoryRoot; index: number; onPick?: (pick: StoryNodePick) => void }) {
  const [adding, setAdding] = useState(false);
  const byId = nodesById(view);
  const running = liveOn(view);
  const run = running.get(root.id);
  const assignee = view.page.team.find((t) => t.assigned.includes(root.id) || t.runs.includes(root.id));
  const p = root.taskProgress;
  const tone = toneOf(root);
  const pick = picker(onPick, actions.open);
  const rename = actions.rename;
  const createTask = actions.createTask;
  const landed = live?.landed;

  return (
    <div className={`stc-root${run ? ' stc-root--live' : ''}${flashOf(landed, root.id)}`}>
      <div>
        <div className="stc-root__hd">
          <KindIcon kind={root.kind} size={16} />
          <div>
            <RenamableTitle title={root.title} className="stc-root__title" rename={rename ? (t) => rename(root.id, t) : undefined} />
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
            <div key={id} className={`stc-tree__c stc-tone--${ct ?? 'cancelled'}${flashOf(landed, id)}`}>
              <i className="stc-tree__dot" aria-hidden />
              <RenamableTitle title={c.title} className="stc-tree__t" rename={rename ? (t) => rename(id, t) : undefined} />
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
        <div className="stc-lbl">trail · {root.trail.length}</div>
        {root.trail.length === 0 ? <span className="stc-quiet">nothing follows from it yet</span> : null}
        {root.trail.map((x) => {
          const n = byId.get(x.id);
          const exited = n?.live === false;
          const memory = VIEW_OF_KIND[x.kind] === 'memories';
          const cls = `stc-chip stc-fam--${x.family}${exited ? ' stc-chip--exited' : ''}${memory ? ' stc-chip--memory' : ''}${flashOf(landed, x.id)}`;
          const body = (
            <>
              <KindIcon kind={x.kind} size={14} />
              <span className="stc-chip__t">{x.title}</span>
              <span className="stc-chip__m">{x.edgeType}</span>
            </>
          );
          return pick ? (
            <button key={`${x.id}-${x.viaId}`} type="button" className={cls} title={x.title} onClick={pick(x.id)}>
              {body}
            </button>
          ) : (
            <span key={`${x.id}-${x.viaId}`} className={cls} title={x.title}>
              {body}
            </span>
          );
        })}
      </div>
    </div>
  );
}
