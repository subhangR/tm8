/**
 * The playground's data: what each intent is called, which rows of the sheet
 * it needs, and the plain-words sentence that says what will happen.
 *
 * Intent-keyed tables, not branches — the sheet and the popover read flags
 * from here, so no component compares an intent (several intent names are
 * also kind names) or a kind.
 */
import type { ReactNode } from 'react';
import type { TeamMemberMode } from '@tm8/contract';

import type { StoryIntent } from '../actions';
import {
  MESSAGE_KIND,
  MODE_WORD,
  SESSION_KIND,
  STORY_KIND,
  TASK_KIND,
  TEAMMATE_KIND,
  liveOn,
  nameOf,
  rootNumber,
  storyCallSign,
  type StoryView,
  teammatesOf,
} from '../model';

export interface IntentSpec {
  intent: StoryIntent;
  label: string;
  /** Kind glyph drawn on the chip. */
  glyph: string;
  /** The submit button's word. */
  go: string;
  /** Pick a target ("on")? A child story always goes under this story. */
  needsOn: boolean;
  /** Pick who runs it ("as")? */
  needsAs: boolean;
  /** The secondary button: switch to this intent instead. Absent = no button. */
  alt?: { to: StoryIntent; label: string };
  /** Mode a new teammate gets unless the user picks another. */
  newMode: TeamMemberMode;
}

export const INTENTS: readonly IntentSpec[] = [
  { intent: 'spawn', label: 'Spawn a session', glyph: SESSION_KIND, go: 'Spawn session', needsOn: true, needsAs: true, alt: { to: 'dispatch', label: 'Dispatch instead' }, newMode: 'coordinated-worker' },
  { intent: 'dispatch', label: 'Dispatch', glyph: TEAMMATE_KIND, go: 'Dispatch', needsOn: true, needsAs: false, alt: { to: 'spawn', label: 'Spawn instead' }, newMode: 'coordinated-worker' },
  { intent: 'task', label: 'Just a task', glyph: TASK_KIND, go: 'Add task', needsOn: true, needsAs: false, newMode: 'coordinated-worker' },
  { intent: 'message', label: 'A message', glyph: MESSAGE_KIND, go: 'Send', needsOn: true, needsAs: false, newMode: 'coordinated-worker' },
  { intent: 'coordinator', label: 'A coordinator', glyph: TEAMMATE_KIND, go: 'Spawn coordinator', needsOn: true, needsAs: true, alt: { to: 'task', label: 'Just add the task' }, newMode: 'coordinator' },
  { intent: 'child-story', label: 'A child story', glyph: STORY_KIND, go: 'Add child story', needsOn: false, needsAs: false, newMode: 'coordinated-worker' },
];

export const INTENT: Readonly<Record<StoryIntent, IntentSpec>> = Object.fromEntries(
  INTENTS.map((s) => [s.intent, s]),
) as Record<StoryIntent, IntentSpec>;

/** The plain "just a task" intent, for callers that add one directly. */
export const TASK_INTENT: StoryIntent = 'task';

/** Modes a new teammate can be made with, in the order the sheet offers them. */
export const NEW_MODES: readonly TeamMemberMode[] = ['coordinated-worker', 'coordinator', 'coordinated-coordinator', 'dispatcher'];

/* ------------------------------------------------------------------------- */
/* The sheet's option rows, derived from the view.                           */
/* ------------------------------------------------------------------------- */

export interface OnOption {
  id: string;
  label: string;
  /** The sentence's name for it ("Fixtures", "the story"). */
  short: string;
  glyph: string;
}

export function onOptions(view: StoryView, extraId?: string | null): OnOption[] {
  const out: OnOption[] = [{ id: view.id, label: 'The story', short: 'the story', glyph: STORY_KIND }];
  for (const r of view.page.roots) {
    out.push({ id: r.id, label: `root ${rootNumber(view, r.id)} · ${r.title}`, short: r.title, glyph: r.kind });
  }
  for (const s of view.page.sessions) {
    if (!s.live) continue;
    const who = nameOf(view, s.teamMemberId);
    out.push({ id: s.id, label: `${s.callSign} · ${who}’s session`, short: `${s.callSign} · ${who}’s session`, glyph: SESSION_KIND });
  }
  if (extraId && !out.some((o) => o.id === extraId)) {
    const n = view.page.nodes.find((x) => x.id === extraId);
    const t = view.page.team.find((x) => x.id === extraId);
    const title = n?.title ?? t?.name;
    if (title) out.push({ id: extraId, label: title, short: title, glyph: n?.kind ?? TEAMMATE_KIND });
  }
  return out;
}

export interface AsOption {
  id: string;
  name: string;
  initials: string;
  modeWord: string;
}

/** Teammates who can run a session (a dispatcher routes work, it does not run it). */
export function asOptions(view: StoryView): AsOption[] {
  return teammatesOf(view.page)
    .filter((t) => t.mode !== 'dispatcher')
    .map((t) => ({
      id: t.id,
      name: t.name,
      initials: view.people[t.id]?.initials ?? t.name.charAt(0),
      modeWord: t.mode ? MODE_WORD[t.mode] : 'teammate',
    }));
}

export interface TellOption {
  id: string;
  name: string;
  initials: string;
  agent: boolean;
  note: string;
}

/** Teammates first, then the people on the story. */
export function tellOptions(view: StoryView): TellOption[] {
  const out: TellOption[] = teammatesOf(view.page).map((t) => ({
    id: t.id,
    name: t.name,
    initials: view.people[t.id]?.initials ?? t.name.charAt(0),
    agent: true,
    note: [t.mode ? MODE_WORD[t.mode] : 'teammate', t.live ? 'live' : null].filter(Boolean).join(' · '),
  }));
  for (const p of Object.values(view.people)) {
    if (p.agent || out.some((o) => o.id === p.id)) continue;
    out.push({ id: p.id, name: p.name, initials: p.initials, agent: false, note: 'member' });
  }
  return out;
}

/** Who is told by default: the story's live coordinators. */
export function defaultTell(view: StoryView): string[] {
  return view.page.team.filter((t) => t.live && t.mode === 'coordinator').map((t) => t.id);
}

/* ------------------------------------------------------------------------- */
/* The plain-words preview.                                                   */
/* ------------------------------------------------------------------------- */

export interface PreviewInput {
  intent: StoryIntent;
  text: string;
  on: OnOption | undefined;
  /** The "as" pick: a teammate, or a new one with a mode. */
  as: { name: string; modeWord: string; isNew: boolean } | null;
  told: string[];
}

const B = ({ children }: { children: ReactNode }) => <b>{children}</b>;

function list(names: string[]): ReactNode[] {
  return names.flatMap((n, i) => [i ? (i === names.length - 1 ? ' and ' : ', ') : null, <B key={n + i}>{n}</B>]);
}

/** The sentence under the sheet: exactly what submitting does, in words. */
export function previewSentence(view: StoryView, p: PreviewInput): ReactNode {
  const text = p.text.trim() || '…';
  const quoted = <B>“{text}”</B>;
  const on = <B>{p.on?.short ?? 'the story'}</B>;
  const sign = storyCallSign(view.page.sessions.length);
  const runner = p.as ? (p.as.isNew ? `a new ${p.as.modeWord}` : p.as.name) : 'a teammate';
  /* The coordinator sentence names the role itself, so a new runner is just "a new teammate". */
  const coordinator = p.as && !p.as.isNew ? p.as.name : 'a new teammate';
  const runnerMode = p.as && !p.as.isNew ? ` as ${p.as.modeWord}` : '';
  const dispatcher = view.page.team.find((t) => t.mode === 'dispatcher');
  const tell = p.told.length ? (
    <> One message goes to {list(p.told)} saying it exists, with the link.</>
  ) : (
    <> Nobody is told beyond the story thread.</>
  );
  const body: Record<StoryIntent, ReactNode> = {
    spawn: (
      <>
        Creates the task {quoted} under {on}, spawns <B>{runner}</B> on it{runnerMode} — call sign <B>{sign}</B> — and the
        session joins the story the moment it exists.
      </>
    ),
    dispatch: (
      <>
        Creates the task {quoted} under {on} and hands it to{' '}
        {dispatcher ? (
          <>
            <B>{dispatcher.name}</B>, the dispatcher,
          </>
        ) : (
          'the dispatcher, '
        )}{' '}
        who routes it to a worker and says why on the task.
      </>
    ),
    task: (
      <>
        Creates the task {quoted} under {on}, to do, unassigned. It is in the story because its parent is.
      </>
    ),
    message: (
      <>
        Posts {quoted} on {on}. {liveOnTarget(view, p.on?.id) ? 'The live session on it receives it on its next turn.' : 'It waits on the anchor for whoever opens it.'}
      </>
    ),
    coordinator: (
      <>
        Spawns <B>{coordinator}</B> as a coordinator on {on} — call sign <B>{sign}</B> — with this as its brief. It can then split
        the work and spawn its own workers.
      </>
    ),
    'child-story': (
      <>
        Creates the child story {quoted} under this story. It gets its own roots, team, graph and feed, and its progress
        rolls up here.
      </>
    ),
  };
  return (
    <>
      {body[p.intent]}
      {tell}
    </>
  );
}

function liveOnTarget(view: StoryView, id: string | undefined): boolean {
  if (!id) return false;
  return view.page.sessions.some((s) => s.id === id && s.live) || liveOn(view).has(id);
}
