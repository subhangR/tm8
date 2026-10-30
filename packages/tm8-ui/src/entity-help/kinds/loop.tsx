/**
 * LOOP — Entity Help, wave 5; rewritten for first-class loops (loops PR6).
 *
 * Fact-checked against the merged code: the loops table and its doors
 * (db/migrations/384_loops_first_class.sql: loop_runs, loop_run_settle;
 * 385_loop_run_claim.sql: loop_run_claim, loops_park_orphans),
 * packages/server/src/scheduler/schedule.ts (`every
 * <n>{m|h|d}` or a five-field cron read in the loop's IANA timezone;
 * describeSchedule; previewSchedule), packages/server/src/loops/write.ts
 * (scheduleWrite: the server sets every next run; a schedule that never
 * matches parks the loop), packages/server/src/scheduler/jobs/loops.ts (the
 * 60 s tick; claim, then fire; overlap skip|queue; retry; max runtime →
 * timed_out; dispatch settles completed at delivery), loops/run-handlers.ts
 * (Run now fires synchronously and answers the run, 409 loop_run_overlap
 * unless forced; runs.stop), packages/cli/src/commands/loop.ts (the toolkit's
 * verbs, docs/api-and-cli/LOOP-CLI.md), the loop form and page
 * (packages/tm8-ui/src/loops/) and bootstrap/default-teammates.ts (the
 * Dreamer's seeded loop).
 *
 * SIGNATURE MOMENT: the metronome. Eight due moments play left to right, one
 * beat at a time: fired, fired, skipped because the last run is still live,
 * three beats lost while the node was down, then a firing counted from then.
 * Each lit firing leaves a run row (↖) and its session's triggered_by. It is
 * the executor's two rules, drawn. Under reduced motion every beat is lit at
 * once and the captions carry the same meaning.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useMotion } from '../motion/MotionContext';
import type { KindHelpModule } from '../types';

type BeatState = 'fired' | 'skipped' | 'missed' | 'recounted';

const METRONOME: readonly { readonly state: BeatState; readonly mark: string; readonly caption: string }[] = [
  { state: 'fired', mark: '●', caption: 'fired' },
  { state: 'fired', mark: '●', caption: 'fired' },
  { state: 'skipped', mark: '◐', caption: 'still live · skipped run' },
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
        ↖ · a run row, and that firing’s session points home (triggered_by)
      </figcaption>
    </figure>
  );
}

export const LOOP_HELP: KindHelpModule = {
  kind: 'loop',

  story: {
    logline: 'A loop is a standing appointment the graph keeps for you, and every kept appointment leaves a run behind it.',

    opening: (
      <>
        <p>
          A loop is a schedule with a job attached. It says <em>when</em>: <code>every 2h</code>, or a five-field cron
          line read in the loop&rsquo;s own timezone (UTC unless you pick one). It says <em>who</em>: a teammate, the
          Dispatcher (which picks one each time), or a tool, run with its inputs. And it says <em>what</em>: the
          instructions every firing carries, and optionally what it is about. When its moment comes, tm8 fires it: a
          teammate&rsquo;s session on a task derived from that subject, a dispatch request, or a tool run. Every firing
          is recorded as a run.
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
        title: 'Every firing is a run',
        body: (
          <p>
            The loop page&rsquo;s RUNS table is the history: one row per firing, by schedule or by Run now, with its
            status (running, completed, failed, skipped, stopped, timed out), how long it took, the task and session it
            made, and why it failed or was skipped. The task and session also point back at the loop with a{' '}
            <code>triggered_by</code> edge, so the graph tells the same story. A firing is claimed and recorded before
            anything is launched, so one that dies halfway still leaves its row.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Skip, never backfill',
        body: (
          <>
            <p>
              The scheduler wakes once a minute and fires whatever is due. If the last firing is still live, a loop set
              to <em>skip</em> records this firing as skipped and waits for the next; one set to <em>queue</em> waits
              and fires as soon as the previous run settles. If the node was down for six hours, the missed firings are
              simply gone: the loop fires once when the node is back, and the next deadline is counted from that
              firing. A loop means <em>do this periodically</em>, not <em>keep a backlog</em>. Six hours of an{' '}
              <code>every 5m</code> loop, replayed, would be seventy-two sessions at once, and that is not catching up.
            </p>
            <Metronome />
          </>
        ),
      },
      {
        eyebrow: 'Who runs it',
        title: 'A teammate, the Dispatcher, or a tool',
        body: (
          <p>
            Pick a teammate and each firing spawns that teammate, with the loop&rsquo;s advanced settings choosing how
            it launches. Pick <em>Dispatcher decides</em> and the firing becomes a dispatch request: the Dispatcher
            picks the hands. Pick a tool and the firing runs it with the inputs you typed; a tool that reaches tm8 runs
            as the teammate you name under <em>Runs as</em>. A teammate&rsquo;s task is derived from what the loop is
            about, or from the loop itself, and an open derived task is reused, so successive firings gather on one
            task until someone closes it. A firing acts as the loop&rsquo;s armer, the human who last created, enabled
            or edited it. Once that person has left the space, or an agent&rsquo;s edit has disarmed the loop, it acts
            as the space&rsquo;s owner, and the page says so; with no owner either, it is parked as{' '}
            <em>needs arming</em> until someone can run it.
          </p>
        ),
      },
      {
        eyebrow: 'Steering it',
        title: 'Run now, pause, and the clock',
        body: (
          <p>
            <strong>Run now</strong> fires the loop at once, beside its schedule, and answers with the run and the
            session it started; while a run is still live it refuses, unless you choose to run anyway.{' '}
            <strong>Pause</strong> holds the firings until an instant (an hour, tomorrow at 09:00, or a time you pick),
            and a deadline that fell inside the pause fires once when it ends. Only the server writes the next run:
            on create, on enable and whenever the schedule or its timezone changes, always counted from now, so a loop
            disabled for a week does not fire the moment it is enabled again. The form&rsquo;s preview asks the server
            too, in the loop&rsquo;s timezone, so what you read is what will happen.
          </p>
        ),
      },
      {
        eyebrow: 'When it breaks',
        title: 'Broken, never retired',
        body: (
          <p>
            A launch that fails (the session could not start) is written to the run and to the loop&rsquo;s last
            error, and the loop stays enabled; with retries set, the launch is tried again after the retry delay, up to
            that many times. A run that starts and then fails, or outlives its max runtime and is stopped as timed out,
            shows on its own row in RUNS; it is not retried and leaves no last error. A schedule that never matches (the
            30th of February) parks the loop with that reason instead of failing quietly. The server never switches off
            a schedule a person set up; fixing it is that person&rsquo;s call, which is why the page prints the last
            error beside the controls. <em>Enabled</em> on its own is not a health claim: read RUNS.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Enabled', note: 'Armed with a next run the server computed. The only state the scheduler looks for.' },
      { name: 'Fired', note: 'A run is recorded and launched: a session, a dispatch or a tool run. The next deadline counts from it.' },
      { name: 'Skipped', note: 'The previous run was still live and the loop is set to skip. Recorded as a skipped run.' },
      { name: 'Waiting on previous run', note: 'Set to queue: it fires as soon as the live run settles.' },
      { name: 'Paused', note: 'Holding until an instant. A deadline missed meanwhile fires once when the pause ends.' },
      { name: 'Failed', note: 'A launch refused: the last error says why, it is retried if set, and the loop stays enabled. A run that failed after it started shows on its row only.' },
      { name: 'Parked', note: 'The schedule never matches (no next run), or there is no one it can run as (needs arming: it fires once someone can). The reason is the last error.' },
      { name: 'Disabled', note: 'Kept whole, deadline preserved; the schedule never fires it (Run now still can). Enable counts the next run from now.' },
      { name: 'Deleted', note: 'Soft-deleted and never due again. Restore brings the appointment back.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        <code>tm8 loop</code> is the loop&rsquo;s own noun, and every verb is one <code>loops.*</code> operation: the
        server owns the next run, the schedule preview and who a firing acts as, so nothing here computes them or
        writes loop fields through the generic entity doors. Create and edit carry the definition; enable, disable,
        pause and resume steer it; run-now fires it once; runs reads what each firing did.
      </p>
    ),

    scenes: [
      {
        title: 'Set the appointment',
        narrative: (
          <p>
            Preview the schedule first: the server answers with a summary and the next instants in the loop&rsquo;s
            timezone. Then create it with a runner. A runner or subject from another space is refused at the door: a
            loop cannot fire across a space boundary.
          </p>
        ),
        commands: ['loop preview', 'loop create'],
        demo: [
          '# a triage pass at 09:00 London time on weekdays, armed from the start',
          "tm8 loop preview --schedule '0 9 * * 1-5' --timezone Europe/London",
          "tm8 loop create 'Morning triage' --schedule '0 9 * * 1-5' --timezone Europe/London --teammate <name|id> --prompt @triage.md",
        ],
      },
      {
        title: 'Pause, retime, fire now',
        narrative: (
          <p>
            Every change carries the version you read. A pause holds the firings until an instant, and a deadline
            missed while paused fires once when it ends; run-now fires it immediately. Because each firing also bumps
            the version, a conflict on a busy loop usually means it just fired: read it again and decide again.
          </p>
        ),
        commands: ['loop show', 'loop pause', 'loop edit', 'loop run-now'],
        demo: [
          '# read the version, then pause for two hours',
          'tm8 loop show <loop-id>',
          'tm8 loop pause <loop-id> --until +2h --expect-version 7',
          "tm8 loop edit <loop-id> --schedule 'every 30m' --expect-version 8",
          'tm8 loop run-now <loop-id>',
        ],
      },
      {
        title: 'Read the run history',
        narrative: (
          <p>
            Every firing is a run with its status, its task and its session. The task and session also point back at
            the loop through inbound <code>triggered_by</code> edges, each carrying when it fired.
          </p>
        ),
        commands: ['loop runs', 'loop run-show', 'edge list'],
        demo: ['tm8 loop runs <loop-id> --status failed', 'tm8 loop run-show <run-id>', 'tm8 edge list --target <loop-id> --type triggered_by'],
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
