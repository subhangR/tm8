/**
 * THE RAIL — the story's status (and `actions.setStatus`), its progress as the
 * server computed it (ring, legend, a bar per root, the child-story rollup),
 * the memories made along the way, the human members, the story as a filter,
 * and the note on what a teammate gets from `tm8 entity context`.
 *
 * Every figure is read off `state` / the roots' `taskProgress`; nothing is
 * tallied here. With no `setStatus` the steps are plain and there is no
 * Complete button.
 */
import type { StatusCategory } from '@tm8/contract';

import { KindIcon } from '../../domain';
import { Avatar } from '../../kit';
import {
  liveOn,
  MESSAGE_KIND,
  nameOf,
  nodesById,
  pct,
  rootNumber,
  segments,
  SESSION_KIND,
  since,
  statusWord,
  TASK_KIND,
  VIEW_OF_KIND,
  type StoryNode,
  type StoryView,
} from '../model';
import type { StoryBlockProps } from '../props';
import { CardHead, Empty, flashOf, MenuDot, Meter, PressTitle, pressOf, rowPress, type Press } from './shared';

/**
 * The default workflow's three steps. The status KEY each step sets is the
 * built-in default's; a story on a custom workflow still lights the step by
 * its category.
 */
const STATUS_STEPS: ReadonlyArray<{ category: StatusCategory; status: string; label: string }> = [
  { category: 'to_do', status: 'open', label: 'To do' },
  { category: 'in_progress', status: 'working', label: 'In progress' },
  { category: 'done', status: 'done', label: 'Done' },
];
const DONE_STATUS = 'done';

/** Ring geometry: r = 40 → circumference 251.3. */
const RING_C = 2 * Math.PI * 40;

export function StoryRail(props: StoryBlockProps) {
  const { view, actions, live } = props;
  const press = pressOf(props);
  return (
    <aside className="stc-rail">
      <StatusCard view={view} actions={actions} />
      <ProgressCard view={view} actions={actions} live={live} />
      <MemoriesCard view={view} actions={actions} live={live} press={press} />
      <MembersCard view={view} actions={actions} press={press} />
      <FilterCard view={view} actions={actions} />
      <section className="stc-card">
        <CardHead title="For a teammate" />
        <div className="stc-body stc-note">
          <code>tm8 entity context &lt;story&gt;</code> returns the description, status, progress per root, everything in it grouped by kind, who
          is running what, and what is blocked. Spawning on the story hands all of that over as context; the session joins the story the moment it
          exists, because it is connected to it.
        </div>
      </section>
    </aside>
  );
}

export function StatusCard({ view, actions }: StoryBlockProps) {
  const at = STATUS_STEPS.findIndex((s) => s.category === view.statusCategory);
  const p = view.state.taskProgress;
  const open = p.work - p.done;
  const openRoots = view.page.roots.filter((r) => r.taskProgress.done < r.taskProgress.work).length;
  const setStatus = actions.setStatus;
  const done = view.statusCategory === 'done';
  const why = done
    ? 'This story is done.'
    : open > 0
      ? `${open} ${open === 1 ? 'task' : 'tasks'} across ${openRoots} ${openRoots === 1 ? 'root is' : 'roots are'} still open.`
      : p.work > 0
        ? 'Every task in it is done.'
        : 'Nothing in it to finish yet.';
  return (
    <section className="stc-card">
      <CardHead title="Status" count={statusWord(view.status)} />
      <div className="stc-body">
        <div className="stc-steps">
          {STATUS_STEPS.map((s, i) => {
            const cls = `stc-step${i < at ? ' stc-step--done' : ''}${i === at ? ' stc-step--now' : ''}`;
            return setStatus && i !== at ? (
              <button key={s.category} type="button" className={cls} title={`set to ${s.label}`} onClick={() => void setStatus(s.status)}>
                <i />
                {s.label}
              </button>
            ) : (
              <span key={s.category} className={cls}>
                <i />
                {s.label}
              </span>
            );
          })}
        </div>
        <div className="stc-statusrow">
          {setStatus && !done ? (
            <button
              type="button"
              className="stc-btn"
              disabled={open > 0}
              title={open > 0 ? why : 'mark the story done'}
              onClick={() => void setStatus(DONE_STATUS)}
            >
              ✓ Complete
            </button>
          ) : null}
          <span className="stc-why">{why}</span>
        </div>
      </div>
    </section>
  );
}

function ProgressCard({ view, live }: StoryBlockProps) {
  const p = view.state.taskProgress;
  const s = segments(p);
  const withAgent = liveOn(view).size;
  const roll = view.state.rollup;
  const parent = view.page.parent;
  // 307: the ring is the points-weighted percent the story list shows (its
  // tasks and its child stories', each once). An older summary without it
  // keeps the task count.
  const weighted = view.state.weighted;
  const ringPct = weighted && weighted.percent !== null ? weighted.percent : pct(p);
  return (
    <section className={`stc-card${flashOf(live?.landed, view.id)}`}>
      <CardHead title="Progress" count="computed · never stored" />
      <div className="stc-body">
        {p.work === 0 ? (
          <Empty>No tasks to count yet. Progress is computed from what is in the story.</Empty>
        ) : (
          <div className="stc-ring">
            <svg viewBox="0 0 96 96" aria-hidden>
              <circle className="stc-ring__track" cx="48" cy="48" r="40" />
              <circle
                className="stc-ring__arc"
                cx="48"
                cy="48"
                r="40"
                strokeDasharray={`${((RING_C * ringPct) / 100).toFixed(1)} ${RING_C.toFixed(1)}`}
                transform="rotate(-90 48 48)"
              />
              <text className="stc-ring__pct" x="48" y="54" textAnchor="middle">
                {ringPct}%
              </text>
            </svg>
            <div>
              <div className="stc-ring__big">
                {p.done}
                <small>of {p.work} tasks done</small>
              </div>
              {weighted && weighted.percent !== null ? (
                <div className="stc-ring__pts" title="Points-weighted: estimates as weights (missing → 1), criteria ticked, child stories included">
                  {Math.floor(weighted.earned)}/{weighted.total} pts weighted
                  {weighted.tents > 0 ? ` · ${weighted.tents} without an estimate` : ''}
                </div>
              ) : null}
              <ul className="stc-legend">
                <li>
                  <i className="stc-tone--done" />
                  {s.done} done
                </li>
                <li>
                  <i className="stc-tone--working" />
                  {s.working} working{withAgent ? ` · ${withAgent} with a live agent` : ''}
                </li>
                <li>
                  <i className="stc-tone--blocked" />
                  {s.blocked} blocked
                  {view.state.pendingAttentionCount ? ` · ${view.state.pendingAttentionCount} waiting on attention` : ''}
                </li>
                <li>
                  <i className="stc-tone--todo" />
                  {s.todo} to do
                </li>
              </ul>
            </div>
          </div>
        )}
        {view.page.roots.length ? (
          <div className="stc-perroot">
            {view.page.roots.map((r, i) => (
              <div key={r.id} className={`stc-perroot__r${flashOf(live?.landed, r.id)}`}>
                <span className="stc-ellipsis">
                  {i + 1} · {r.title}
                </span>
                <Meter progress={r.taskProgress} thin />
                <span className="stc-perroot__p">
                  {r.weighted && r.weighted.percent !== null ? `${r.weighted.percent}% · ` : ''}
                  {r.taskProgress.done}/{r.taskProgress.work}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {view.state.childStoryCount > 0 ? (
          <div className="stc-rollup">
            <div>
              With <b>{view.state.childStoryCount} child {view.state.childStoryCount === 1 ? 'story' : 'stories'}</b>:{' '}
              <b>
                {roll.done} of {roll.work}
              </b>{' '}
              tasks done · {pct(roll)}%<span className="stc-m"> · rolled up</span>
            </div>
            <div className="stc-m">
              this story alone is {p.done} of {p.work}
              {parent ? `; the parent, ${parent.title}, rolls this one up the same way` : ''}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Who made a memory: the session (or teammate) it hangs off, by its stored edge. */
function memoryBy(view: StoryView, m: StoryNode): { who: string; whoId: string | null; line: string } {
  const sessions = new Map(view.page.sessions.map((s) => [s.id, s]));
  const edge = view.page.edges.find((e) => (e.fromId === m.id && sessions.has(e.toId)) || (e.toId === m.id && sessions.has(e.fromId)));
  const s = edge ? sessions.get(edge.fromId === m.id ? edge.toId : edge.fromId) : undefined;
  const root = m.rootIds[0] ? rootNumber(view, m.rootIds[0]) : 0;
  const bits = [root > 0 ? `root ${root}` : null];
  if (s) bits.push(s.live ? 'live now' : 'from the session that exited');
  else bits.push(since(m.activityAt ?? m.createdAt));
  return { who: s ? nameOf(view, s.teamMemberId) : 'made here', whoId: s?.teamMemberId ?? null, line: bits.filter(Boolean).join(' · ') };
}

function MemoriesCard({ view, live, press }: StoryBlockProps & { press: Press }) {
  const memories = view.page.nodes.filter((n) => VIEW_OF_KIND[n.kind] === 'memories');
  return (
    <section className="stc-card">
      <CardHead title="Memories" count={memories.length ? `${memories.length} · made along the way` : undefined} />
      <div className="stc-body stc-body--list">
        {memories.length === 0 ? <Empty>No memories yet. What a session remembers while working on the story shows here.</Empty> : null}
        {memories.map((m) => {
          const by = memoryBy(view, m);
          const person = by.whoId ? view.people[by.whoId] ?? null : null;
          return (
            <div
              key={m.id}
              className={`stc-memory${press.sel(m.id)}${flashOf(live?.landed, m.id)}`}
              data-entity={m.id}
              onClick={rowPress(press, m.id)}
              onContextMenu={press.menu?.(m.id)}
            >
              <span className="stc-memory__hd">
                <PressTitle id={m.id} title={m.title} press={press} className="stc-memory__s" />
                <MenuDot id={m.id} label={m.title} press={press} />
              </span>
              <div className="stc-memory__by">
                {by.whoId ? <Avatar actorId={by.whoId} provenance="agent" label={by.who} initials={person?.initials} size={15} /> : null}
                {by.whoId ? `${by.who} · ` : ''}
                {by.line}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MembersCard({ view, press }: StoryBlockProps & { press: Press }) {
  const humans = Object.values(view.people).filter((p) => !p.agent);
  return (
    <section className="stc-card">
      <CardHead title="Members" count={humans.length ? `${humans.length} ${humans.length === 1 ? 'human' : 'humans'} · teammates are in Team above` : undefined} />
      <div className="stc-body stc-people">
        {humans.length === 0 ? <Empty>No people on it yet. Anyone who works on something in the story shows here.</Empty> : null}
        {humans.map((h) => {
          const last = view.page.activity.find((a) => a.actorId === h.id);
          const did = view.page.activity.filter((a) => a.actorId === h.id).length;
          const role = last ? `member · ${did} ${did === 1 ? 'change' : 'changes'} here · last ${since(last.at)}` : 'member';
          const body = (
            <>
              <Avatar actorId={h.id} provenance="human" label={h.name} initials={h.initials} size={22} />
              <span>
                <span className="stc-person__n">{h.name}</span>
                <span className="stc-person__r">{role}</span>
              </span>
            </>
          );
          return (
            <div key={h.id} className={`stc-person${press.sel(h.id)}`} data-entity={h.id} onContextMenu={press.menu?.(h.id)}>
              <PressTitle id={h.id} title={body} press={press} className="stc-person__press" />
              <MenuDot id={h.id} label={h.name} press={press} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The story as a filter on every list. The counts are the server's (tasks =
 * work + cancelled; sessions and memories are the page's rows). There is no
 * navigate-to-a-filtered-list action on `StoryActions` yet, so the rows are
 * read-only.
 */
function FilterCard({ view }: StoryBlockProps) {
  const byId = nodesById(view);
  const memories = [...byId.values()].filter((n) => VIEW_OF_KIND[n.kind] === 'memories').length;
  const memoryKind = Object.keys(VIEW_OF_KIND).find((k) => VIEW_OF_KIND[k] === 'memories') ?? MESSAGE_KIND;
  const rows = [
    { kind: TASK_KIND, label: 'Tasks in this story', n: view.state.taskProgress.work + view.state.taskProgress.cancelled },
    { kind: SESSION_KIND, label: 'Sessions in this story', n: view.page.sessions.length },
    { kind: memoryKind, label: 'Memories in this story', n: memories },
    { kind: MESSAGE_KIND, label: 'Recent messages across the story', n: view.feed.length },
  ];
  return (
    <section className="stc-card">
      <CardHead title="Use as a filter" count="every list" />
      <div className="stc-body stc-filters">
        {rows.map((r) => (
          <div key={r.label} className="stc-filter">
            <KindIcon kind={r.kind} size={14} />
            {r.label}
            <span className="stc-filter__n">{r.n}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
