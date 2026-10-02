/**
 * TEAM ON THIS STORY — the teammates behind the story's sessions, drawn as the
 * teammate tree tm8 already has (`parentId`), each with its sessions by call
 * sign, what it runs, what it was assigned and what it dispatched.
 *
 * Adds ride `actions.add`: the head adds a top-level coordinator, dispatcher or
 * worker on the story; a coordinating row adds a sub-coordinator or a worker
 * under its live session; a dispatcher row dispatches a task as itself. With
 * no `add`, none of those buttons is drawn.
 */
import { useState } from 'react';
import type { TeamMemberMode } from '@tm8/contract';

import { KindIcon } from '../../domain';
import { Pill } from '../../kit';
import type { StoryIntent } from '../actions';
import { MODE_WORD, nodesById, SESSION_KIND, TASK_KIND, type StorySession, type StoryTeammate } from '../model';
import type { StoryBlockProps, StoryNodePick } from '../props';
import { CardHead, Empty, flashOf, InlineEntry, PersonAvatar, picker } from './shared';

/** One add button: what it asks for and what it sends. */
interface AddSpec {
  key: string;
  label: string;
  intent: StoryIntent;
  mode: TeamMemberMode | null;
  /** Runs as the row's teammate (dispatch) rather than a new one. */
  asSelf?: boolean;
  placeholder: string;
}

const HEAD_ADDS: readonly AddSpec[] = [
  { key: 'coordinator', label: '＋ Coordinator', intent: 'coordinator', mode: 'coordinator', placeholder: 'What should the new coordinator run?' },
  { key: 'dispatcher', label: '＋ Dispatcher', intent: 'spawn', mode: 'dispatcher', placeholder: 'What should the new dispatcher hand out?' },
  { key: 'worker', label: '＋ Worker', intent: 'spawn', mode: 'worker', placeholder: 'What should the new worker do?' },
];

/** What a row offers, by the teammate's mode. Modes are data, not kinds. */
const ROW_ADDS: Readonly<Partial<Record<TeamMemberMode, readonly AddSpec[]>>> = {
  coordinator: [
    { key: 'sub', label: '＋ sub-coordinator', intent: 'coordinator', mode: 'coordinated-coordinator', placeholder: 'What should the sub-coordinator own?' },
    { key: 'worker', label: '＋ worker', intent: 'spawn', mode: 'coordinated-worker', placeholder: 'What should the worker do?' },
  ],
  'coordinated-coordinator': [
    { key: 'sub', label: '＋ sub-coordinator', intent: 'coordinator', mode: 'coordinated-coordinator', placeholder: 'What should the sub-coordinator own?' },
    { key: 'worker', label: '＋ worker', intent: 'spawn', mode: 'coordinated-worker', placeholder: 'What should the worker do?' },
  ],
  dispatcher: [{ key: 'dispatch', label: '＋ dispatch a task', intent: 'dispatch', mode: null, asSelf: true, placeholder: 'The task to dispatch' }],
};

/** The tfoot's mode words, in tm8's own order. */
const MODES: readonly TeamMemberMode[] = ['coordinator', 'coordinated-coordinator', 'coordinated-worker', 'worker', 'dispatcher'];

export function TeamCard({ view, actions, live, onPick }: StoryBlockProps & { onPick?: (pick: StoryNodePick) => void }) {
  const team = view.page.team;
  const [adding, setAdding] = useState<{ spec: AddSpec; onId: string; asId: string | null; tellIds: string[] } | null>(null);

  const ids = new Set(team.map((t) => t.id));
  const tops = team.filter((t) => !t.parentId || !ids.has(t.parentId));
  const modeCount = new Map<string, number>();
  for (const t of team) {
    const w = t.mode ? MODE_WORD[t.mode] : 'teammate';
    modeCount.set(w, (modeCount.get(w) ?? 0) + 1);
  }
  const count = team.length
    ? `${team.length} ${team.length === 1 ? 'teammate' : 'teammates'} · ${[...modeCount].map(([m, n]) => `${n} ${m}`).join(' · ')}`
    : undefined;

  const add = actions.add;
  const start = (spec: AddSpec, row: StoryTeammate | null) => {
    const liveSession = row ? view.page.sessions.find((s) => s.live && s.teamMemberId === row.id) : undefined;
    setAdding({
      spec,
      onId: liveSession?.id ?? view.id,
      asId: spec.asSelf && row ? row.id : null,
      tellIds: row && !spec.asSelf ? [row.id] : [],
    });
  };

  return (
    <section className="stc-card">
      <CardHead title="Team on this story" count={count}>
        {add
          ? HEAD_ADDS.map((spec) => (
              <button key={spec.key} type="button" className="stc-btn stc-btn--sm" onClick={() => start(spec, null)}>
                {spec.label}
              </button>
            ))
          : null}
      </CardHead>
      {adding && add ? (
        <div className="stc-team__adding">
          <InlineEntry
            placeholder={adding.spec.placeholder}
            submitLabel={adding.spec.intent === 'dispatch' ? 'Dispatch' : 'Spawn'}
            onSubmit={(text) =>
              add({ intent: adding.spec.intent, text, onId: adding.onId, asTeammateId: adding.asId, mode: adding.spec.mode, tellIds: adding.tellIds })
            }
            onClose={() => setAdding(null)}
          />
        </div>
      ) : null}
      {team.length === 0 ? (
        <Empty>No teammate is on this story yet. A session spawned on it, or on anything in it, joins the team here.</Empty>
      ) : (
        <div className="stc-team">
          {tops.map((t) => (
            <TeamRows key={t.id} t={t} depth={0} view={view} actions={actions} live={live} onPick={onPick} onAdd={add ? start : undefined} />
          ))}
        </div>
      )}
      <div className="stc-tfoot">
        <span>modes are tm8’s own:</span>
        {MODES.map((m) => (
          <code key={m}>{m}</code>
        ))}
        <span>
          · a coordinated teammate reports to the coordinator above it · a dispatcher hands tasks out and the session that picks one up is{' '}
          <code>dispatched_by</code> its session
        </span>
        <span>
          · every session takes a <b>call sign</b> in creation order — Ash, Birch, Cedar, Dune… — the order never changes, a new session takes the next name
        </span>
      </div>
    </section>
  );
}

function TeamRows({
  t,
  depth,
  view,
  actions,
  live,
  onPick,
  onAdd,
}: StoryBlockProps & {
  t: StoryTeammate;
  depth: number;
  onPick?: (pick: StoryNodePick) => void;
  onAdd?: (spec: AddSpec, row: StoryTeammate) => void;
}) {
  const byId = nodesById(view);
  const titleOf = (id: string) => byId.get(id)?.title ?? 'a task';
  const sessions = view.page.sessions.filter((s) => t.sessionIds.includes(s.id) || s.teamMemberId === t.id);
  const isLive = t.live || sessions.some((s) => s.live);
  const person = view.people[t.id] ?? null;
  const signOf = (id: string | null): StorySession | undefined => (id ? view.page.sessions.find((s) => s.id === id) : undefined);
  const latest = [...sessions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const reports = view.page.team.filter((x) => x.parentId === t.id);
  const adds = (t.mode && ROW_ADDS[t.mode]) || [];

  const pick = picker(onPick, actions.open);
  const taskRef = (id: string) =>
    pick ? (
      <button type="button" className="stc-link" onClick={pick(id)}>
        {titleOf(id)}
      </button>
    ) : (
      <b>{titleOf(id)}</b>
    );

  return (
    <>
      <div className={`stc-trow${flashOf(live?.landed, t.id)}`} style={{ marginLeft: depth * 28 }}>
        {depth ? <span className="stc-trow__guide" aria-hidden /> : null}
        <div className="stc-trow__ident">
          <PersonAvatar id={t.id} person={person} fallbackName={t.name} agent size={22} live={isLive} />
          <span className="stc-trow__name">{t.name}</span>
          {t.mode ? <span className={`stc-mode stc-mode--${t.mode}`}>{t.mode}</span> : null}
        </div>
        <div className="stc-trow__on">
          {sessions.length ? (
            <span className="stc-trow__line">
              <KindIcon kind={SESSION_KIND} size={14} />
              {sessions.map((s, i) => (
                <span key={s.id}>
                  {i ? ' · ' : ''}
                  <b>{s.callSign}</b> · {s.live ? 'live' : 'exited'}
                </span>
              ))}
              <span className="stc-m">{sessions.length === 1 ? 'session' : 'sessions'}</span>
            </span>
          ) : null}
          {t.runs.map((id) => (
            <span key={`r${id}`} className="stc-trow__line">
              <KindIcon kind={TASK_KIND} size={14} />
              running {taskRef(id)}
              <span className="stc-m">working_on</span>
            </span>
          ))}
          {t.assigned.map((id) => (
            <span key={`a${id}`} className="stc-trow__line">
              <KindIcon kind={TASK_KIND} size={14} />
              assigned {taskRef(id)}
              <span className="stc-m">assigned_to</span>
            </span>
          ))}
          {t.dispatched.map((d) => {
            const s = signOf(d.sessionId);
            const who = s?.teamMemberId ? view.people[s.teamMemberId]?.name ?? s.title : s?.title;
            return (
              <span key={`d${d.taskId}`} className="stc-trow__line">
                <KindIcon kind={TASK_KIND} size={14} />
                dispatched {taskRef(d.taskId)}
                <span className="stc-m">{s ? `picked up by ${who} · ${s.callSign}` : 'waiting for a worker'}</span>
              </span>
            );
          })}
          {!sessions.length && !t.runs.length && !t.assigned.length && !t.dispatched.length ? (
            <span className="stc-trow__line stc-quiet">nothing running yet</span>
          ) : null}
        </div>
        <div className="stc-trow__acts">
          {isLive ? (
            <Pill tone="run" dot="pulse">
              live
            </Pill>
          ) : (
            <Pill tone="idle">idle</Pill>
          )}
          {onAdd
            ? adds.map((spec) => (
                <button key={spec.key} type="button" className="stc-btn stc-btn--ghost stc-btn--sm" onClick={() => onAdd(spec, t)}>
                  {spec.label}
                </button>
              ))
            : null}
          {!adds.length && latest && actions.open ? (
            <button type="button" className="stc-btn stc-btn--ghost stc-btn--sm" onClick={() => actions.open!(latest.id)}>
              ↗ open session
            </button>
          ) : null}
        </div>
      </div>
      {reports.map((r) => (
        <TeamRows key={r.id} t={r} depth={depth + 1} view={view} actions={actions} live={live} onPick={onPick} onAdd={onAdd} />
      ))}
    </>
  );
}
