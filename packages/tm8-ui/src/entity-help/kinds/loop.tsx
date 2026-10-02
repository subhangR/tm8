/**
 * LOOP — Entity Help, wave 5.
 *
 * Fact-checked against db/migrations/091_loops.sql (the table and both doors),
 * packages/server/src/scheduler/jobs/loops.ts (the executor: skip, never
 * backfill; overlap guard; errors never disable), scheduler/schedule.ts (the
 * `every <n>{m|h|d}` / 5-field UTC cron grammar), createLoopExecutorPort in
 * facade/execution-handlers.ts (derive task → triggered_by → spawn or
 * dispatch → triggered_by), loops/LoopControls.tsx (Run now, Disable keeps
 * the deadline) and bootstrap/default-teammates.ts (the Dreamer's seeded loop).
 *
 * SIGNATURE MOMENT: the metronome. Eight due moments play left to right, one
 * beat at a time: fired, fired, skipped because the last session is still
 * live, three beats lost while the node was down, then a firing counted from
 * now. Each lit firing shows its receipt (↖), the session's triggered_by.
 * It is the executor's two rules, drawn. Under reduced motion every beat
 * is lit at once and the captions carry the same meaning.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useMotion } from '../motion/MotionContext';
import type { KindHelpModule } from '../types';

type BeatState = 'fired' | 'skipped' | 'missed' | 'recounted';

const METRONOME: readonly { readonly state: BeatState; readonly mark: string; readonly caption: string }[] = [
  { state: 'fired', mark: '●', caption: 'fired' },
  { state: 'fired', mark: '●', caption: 'fired' },
  { state: 'skipped', mark: '◐', caption: 'still live · skip' },
  { state: 'missed', mark: '×', caption: 'down · gone' },
  { state: 'missed', mark: '×', caption: 'down · gone' },
  { state: 'missed', mark: '×', caption: 'down · gone' },
  { state: 'recounted', mark: '●', caption: 'fired · next from now' },
  { state: 'fired', mark: '●', caption: 'fired' },
];

const BEAT_MS = 520;

const strip: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: `repeat(${METRONOME.length}, minmax(0, 1fr))`,
  gap: 'var(--pn-space-2)',
  listStyle: 'none',
  margin: 'var(--pn-space-4) 0 0',
  padding: 'var(--pn-space-4) var(--pn-space-3) var(--pn-space-3)',
  borderRadius: 'var(--pn-r-md)',
  border: '1px solid var(--eh-line)',
  background: 'var(--eh-card)',
  position: 'relative',
};

function cellStyle(state: BeatState, lit: boolean): CSSProperties {
  const missed = state === 'missed';
  return {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 'var(--pn-space-2)',
    minWidth: 0,
    opacity: lit ? 1 : 0.28,
    transition: 'opacity var(--pn-dur-base) var(--pn-ease-standard)',
    ...(missed
      ? { backgroundImage: 'repeating-linear-gradient(135deg, var(--eh-line) 0 1px, transparent 1px 7px)', borderRadius: 'var(--pn-r-sm)' }
      : {}),
  };
}

function markStyle(state: BeatState, lit: boolean): CSSProperties {
  const hot = state === 'fired' || state === 'recounted';
  return {
    display: 'grid',
    placeItems: 'center',
    width: 30,
    height: 30,
    borderRadius: 'var(--pn-r-pill)',
    fontSize: 15,
    lineHeight: 1,
    color: hot ? 'var(--eh-brass)' : 'var(--eh-ink-3)',
    border: state === 'missed' ? '1px dashed var(--eh-line)' : `1px solid ${hot ? 'var(--eh-brass)' : 'var(--eh-line)'}`,
    background: hot && lit ? 'var(--eh-glow)' : 'transparent',
    ...(lit && hot ? { animation: 'eh-reveal 420ms var(--eh-ease) both' } : {}),
  };
}

const caption: CSSProperties = {
  fontFamily: 'var(--pn-mono)',
  fontSize: 'var(--pn-fs-fine)',
  lineHeight: 1.3,
  textAlign: 'center',
  color: 'var(--eh-ink-2)',
  overflowWrap: 'anywhere',
};

const receipt: CSSProperties = {
  fontFamily: 'var(--pn-mono)',
  fontSize: 15,
  lineHeight: 1,
  color: 'var(--eh-brass)',
  minHeight: '1em',
};

/** The metronome: two executor rules, played as eight due moments. */
function Metronome() {
  const { reduced } = useMotion();
  const [lit, setLit] = useState(reduced ? METRONOME.length : 0);

  useEffect(() => {
    if (reduced) {
      setLit(METRONOME.length);
      return;
    }
    setLit(0);
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      setLit(n);
      if (n >= METRONOME.length) clearInterval(timer);
    }, BEAT_MS);
    return () => clearInterval(timer);
  }, [reduced]);

  return (
    <figure style={{ margin: 0 }} data-testid="loop-metronome">
      <ol style={strip} aria-label="Eight due moments of one loop">
        {METRONOME.map((beat, index) => {
          const on = index < lit;
          const hot = beat.state === 'fired' || beat.state === 'recounted';
          return (
            <li key={index} style={cellStyle(beat.state, on)} data-beat={beat.state}>
              <span style={markStyle(beat.state, on)} aria-hidden>
                {beat.mark}
              </span>
              <span style={caption}>{beat.caption}</span>
              <span style={receipt} aria-hidden>
                {hot ? '↖' : ''}
              </span>
            </li>
          );
        })}
      </ol>
      <figcaption className="eh-eyebrow" style={{ display: 'block', marginTop: 'var(--pn-space-2)' }}>
        ↖ · a new triggered_by from that firing’s session
      </figcaption>
    </figure>
  );
}

export const LOOP_HELP: KindHelpModule = {
  kind: 'loop',

  story: {
    logline: 'A loop is a standing appointment the graph keeps for you, and every kept appointment leaves a receipt pointing home.',

    opening: (
      <>
        <p>
          A loop is a schedule with a job attached. It says <em>when</em> (<code>every 1d</code>, or a five-field cron
          line read in UTC), <em>who</em> (a teammate, or nobody, which hands each firing to the Dispatcher) and{' '}
          <em>what</em> (a prompt every firing carries). When its moment comes, tm8 derives a
          task, spawns a session on it and ties both back to the loop.
        </p>
        <p>
          Before loops, periodic work lived in someone&rsquo;s head or in a crontab on one machine, and whether it had
          run was recorded nowhere anyone could see. A loop moves the appointment into the graph, where anyone can read
          it, pause it, retime it, or ask what it has done. The house Dreamer ships with one already:{' '}
          <strong>Dreamer daily sweep</strong>, every day, enabled from the start.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'Why it exists',
        title: 'The receipts are the history',
        body: (
          <p>
            There is no run log. Each firing&rsquo;s session points back at the loop with a{' '}
            <code>triggered_by</code> edge, and so does the task it works on, so the loop&rsquo;s inbound edges{' '}
            <em>are</em> its run history. The RUNS block on the panel is that edge list, counted. The task&rsquo;s
            edge is written before the session is spawned, so a firing that dies halfway still leaves its mark.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Skip, never backfill',
        body: (
          <>
            <p>
              The scheduler wakes about once a minute and fires whatever is due. If the last firing&rsquo;s session is
              still live, this one is skipped. If the node was down for six hours, the missed firings are simply gone,
              and the next deadline is counted from now. A loop means <em>do this periodically</em>, not{' '}
              <em>keep a queue</em>. Six hours of an <code>every 5m</code> loop, replayed, would be seventy-two sessions at
              once, and that is not catching up.
            </p>
            <Metronome />
          </>
        ),
      },
      {
        eyebrow: 'Who runs it',
        title: 'A named runner, or the Dispatcher',
        body: (
          <p>
            Name a teammate and each firing spawns that teammate, with the loop&rsquo;s spawn config choosing model,
            tool and access mode. Leave the runner blank and the firing becomes a dispatch request, and the Dispatcher
            picks the hands. The task is derived from the loop&rsquo;s subject, or from the loop itself when it names
            none, and an open derived task is reused, so successive firings gather on one task until someone closes it.
          </p>
        ),
      },
      {
        eyebrow: 'When it breaks',
        title: 'Broken, never retired',
        body: (
          <p>
            A spawn refusal or a schedule that will not parse is written to the loop&rsquo;s last error, and the loop
            stays enabled. The server never switches off a schedule a person set up; fixing it is that person&rsquo;s
            call. That is why the panel prints the error beside the switch. <em>Enabled</em> on its own is not a health
            claim.
          </p>
        ),
      },
      {
        eyebrow: 'The catch',
        title: 'No next run, no firing',
        body: (
          <p>
            The scheduler reads one column: the next run time. The app&rsquo;s create form fills it in. A loop made from
            the command line without a <code>nextRunAt</code> is stored, valid, and never due. <strong>Run now</strong>{' '}
            sets that time to the present, so the firing starts on the next pass. <strong>Disable</strong> keeps the
            stored deadline, and enabling again picks up where it was.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Armed', note: 'Enabled, with a next run time. The only state the scheduler looks for.' },
      { name: 'Due', note: 'That time has passed. The next scheduler pass, within about a minute, takes it.' },
      { name: 'Fired', note: 'Task derived or reused, session spawned, receipts written, next deadline counted from now.' },
      { name: 'Skipped', note: 'The last session is still live, or the firing failed. Last error says which; still enabled.' },
      { name: 'Disabled', note: 'Kept whole, deadline preserved. Enable resumes it.' },
      { name: 'Deleted', note: 'Soft-deleted and never due again. Restore brings the appointment back.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        There is no <code>loop</code> noun, and that is deliberate: a loop is an ordinary entity with a sharp content
        shape (<code>schedule</code>, <code>teamMemberId</code>, <code>subjectId</code>, <code>prompt</code>,{' '}
        <code>config</code>, <code>enabled</code>, <code>nextRunAt</code>). You make it with the generic create, steer it
        with versioned updates, and read its life as edges. The scheduler itself writes through the same update door, so
        its advances land in the ledger beside yours.
      </p>
    ),

    scenes: [
      {
        title: 'Set the appointment',
        narrative: (
          <p>
            Create it with its schedule and, unless you want it parked, a first <code>nextRunAt</code>. A runner or
            subject from another space is refused at the door: a loop cannot fire across a space boundary.
          </p>
        ),
        commands: ['entity create'],
        demo: [
          '# a triage pass at 09:00 UTC, armed from the start',
          'tm8 entity create loop "Morning triage" --content @loop.json',
          '# loop.json: schedule "0 9 * * *", a runner, a prompt, a nextRunAt',
        ],
      },
      {
        title: 'Pause, retime, fire now',
        narrative: (
          <p>
            Every change carries the version you read. <code>enabled: false</code> pauses it with the deadline kept; a{' '}
            <code>nextRunAt</code> of now is the panel&rsquo;s Run now. Because each firing also bumps the version, a
            conflict on a busy loop usually means it just fired: read it again and decide again.
          </p>
        ),
        commands: ['entity update', 'entity context'],
        demo: [
          '# read the version, then pause',
          'tm8 entity context <loop-id>',
          'tm8 entity update <loop-id> --expect-version 7 --content \'{"enabled":false}\'',
        ],
      },
      {
        title: 'Read the run history',
        narrative: (
          <p>
            Ask for the inbound <code>triggered_by</code> edges and you have every firing: each source is a task or a
            session you can open, and each edge carries when it fired.
          </p>
        ),
        commands: ['edge list', 'entity connections'],
        demo: ['tm8 edge list --target <loop-id> --type triggered_by'],
      },
      {
        title: 'The hands behind a firing',
        narrative: (
          <p>
            A firing with a runner is the same spawn <code>tm8 session spawn</code> makes, with the loop&rsquo;s prompt
            as launch context. Without one it is the same request <code>tm8 session dispatch</code> sends. You can do
            either by hand, off-schedule, when a single run is all you need.
          </p>
        ),
        commands: ['session spawn', 'session dispatch'],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A loop&rsquo;s map is lopsided on purpose. Almost everything points <em>at</em> it: the tasks and sessions it
        caused, through <code>triggered_by</code>. Its runner and subject are not edges at all. They are fields in its
        content, so they do not appear here; open the panel&rsquo;s details for them. Read the inbound fan and you have
        read its life.
      </p>
    ),
    notes: {
      triggered_by: 'Every firing’s task and session point here. Read inbound, this is the run history; each edge carries firedAt.',
      attached_to: 'Pin the runbook or the doc that explains why this appointment exists.',
      relates_to: 'For the loops that belong together, when nothing more specific fits.',
    },
    spotlight: ['task', 'work_session'],
  },
};
