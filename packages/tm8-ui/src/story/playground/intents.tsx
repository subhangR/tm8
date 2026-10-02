/**
 * The playground's data: what each intent is called, which rows of the sheet
 * it needs, and the plain-words sentence that says what will happen.
 *
 * Intent-keyed tables, not branches — the sheet and the popover read flags
 * from here, so no component compares an intent (several intent names are
 * also kind names) or a kind.
 */
import type { ReactNode } from 'react';

import type { StoryIntent } from '../actions';
import type { StoryRunner } from '../props';
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
}

export const INTENTS: readonly IntentSpec[] = [
  { intent: 'spawn', label: 'Spawn a session', glyph: SESSION_KIND, go: 'Spawn session', needsOn: true, needsAs: true, alt: { to: 'dispatch', label: 'Dispatch instead' } },
  { intent: 'dispatch', label: 'Dispatch', glyph: TEAMMATE_KIND, go: 'Dispatch', needsOn: true, needsAs: false, alt: { to: 'spawn', label: 'Spawn instead' } },
  { intent: 'task', label: 'Just a task', glyph: TASK_KIND, go: 'Add task', needsOn: true, needsAs: false },
  { intent: 'message', label: 'A message', glyph: MESSAGE_KIND, go: 'Send', needsOn: true, needsAs: false },
  { intent: 'coordinator', label: 'A coordinator', glyph: TEAMMATE_KIND, go: 'Spawn coordinator', needsOn: true, needsAs: true, alt: { to: 'task', label: 'Just add the task' } },
  { intent: 'child-story', label: 'A child story', glyph: STORY_KIND, go: 'Add child story', needsOn: false, needsAs: false },
];

export const INTENT: Readonly<Record<StoryIntent, IntentSpec>> = Object.fromEntries(
  INTENTS.map((s) => [s.intent, s]),
) as Record<StoryIntent, IntentSpec>;

/** The plain "just a task" intent, for callers that add one directly. */
export const TASK_INTENT: StoryIntent = 'task';

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

const DISPATCHER_MODE = 'dispatcher';

function modeWordOf(mode: string | null | undefined): string {
  return (mode && MODE_WORD[mode as keyof typeof MODE_WORD]) || 'teammate';
}

/**
 * Who can run a launch: AGENT teammates only (never a human member), never a
 * dispatcher (it routes work, it does not run it). The ones already on the
 * story come first, then the rest of the space's launch roster in its own
 * order — so a fresh story with nobody on it can still get its first session.
 */
export function asOptions(view: StoryView, runners?: readonly StoryRunner[] | null): AsOption[] {
  const out: AsOption[] = [];
  const seen = new Set<string>();
  const push = (id: string, name: string, mode: string | null | undefined) => {
    if (seen.has(id) || mode === DISPATCHER_MODE) return;
    seen.add(id);
    out.push({ id, name, initials: view.people[id]?.initials ?? name.charAt(0), modeWord: modeWordOf(mode) });
  };
  const roster = runners ? new Set(runners.map((r) => r.id)) : null;
  for (const t of teammatesOf(view.page)) {
    // With a roster, a story teammate that cannot launch (unsupported model) is not offered.
    if (!roster || roster.has(t.id)) push(t.id, t.name, t.mode);
  }
  for (const r of runners ?? []) push(r.id, r.name, r.mode);
  return out;
}

/**
 * The pre-picked runner, by intent: a coordinator launch prefers a
 * coordinator, any other launch a worker — the story's own first (options
 * list them first), then the roster's in its order (recently launched first,
 * then by name). Neither found: the roster's first launchable teammate, the
 * launch dialog's own default; else the first option.
 */
export function defaultAs(
  options: readonly AsOption[],
  runners: readonly StoryRunner[] | null | undefined,
  intent: StoryIntent,
): string | null {
  const ids = new Set(options.map((o) => o.id));
  const want = intent === 'coordinator' ? MODE_WORD.coordinator : MODE_WORD.worker;
  const byMode = options.find((o) => o.modeWord === want);
  if (byMode) return byMode.id;
  const first = (runners ?? []).find((r) => ids.has(r.id));
  return first?.id ?? options[0]?.id ?? null;
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
  /** The teammate it runs as (spawn / coordinator); null = none picked yet. */
  as: { name: string; modeWord: string } | null;
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
  const runner = p.as?.name ?? 'a teammate';
  const runnerMode = p.as ? ` as ${p.as.modeWord}` : '';
  /* A coordinator on a live session is spawned under it: a sub-coordinator. */
  const onLiveSession = !!p.on && view.page.sessions.some((s) => s.live && s.id === p.on!.id);
  const role = onLiveSession ? MODE_WORD['coordinated-coordinator'] : MODE_WORD.coordinator;
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
        Spawns <B>{runner}</B> as a {role} on {on}{onLiveSession ? ', under that session' : ''} — call sign <B>{sign}</B> — with
        this as its brief. It can then split the work and spawn its own workers.
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
