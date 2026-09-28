/**
 * WORK SESSION — Entity Help, Wave 1 (task 01a0e7d6).
 *
 * Fact sources, so a later edit can re-check them rather than trust the prose:
 *   statuses; idle = output then ~10s quiet, not "waiting"  contract WorkSessionStatus; execution pty/types.ts, PtyHostService
 *   status → category; interrupted failures stay open        migrations 155, 174
 *   the tick files under Done and keeps the process          migrations 156, 204; registry.ts rowActions note
 *   resume = same provider conversation, only from ended     migration 062; SpawnService resume
 *   continue = a new session on a "Continue:" task           migration 200
 *   worktree lanes: tm8/<worktreeId>, default-branch base    execution spawn/worktree-provisioning.ts, WorktreeManager
 *   messages become prompts; queued while spawning; refused  message-dispatch.ts; PtyHostService; migration 253
 *   when exited; never delivered its own
 *   share (watch) and drive (type) are separate dials        migration 187
 *
 * NOT CLAIMED, on purpose: that `handoff send` writes into the terminal (its
 * delivery adapter is not wired in production), and that merged/abandoned
 * lanes are reconciled automatically (the reconciler never infers either).
 *
 * THE SIGNATURE is the heartbeat: the status is drawn as a trace, because it
 * is read off the process rather than chosen by anyone.
 */
import type { KindHelpModule } from '../types';
import { SignatureStage, at } from './SignatureStage';

/* The trace: a flat spawn, a busy run, a quiet idle, a burst, the end. Drawn
   in a 600-wide box; pathLength normalises the dash so the draw is linear. */
const TRACE =
  'M0 44 L100 44 ' +
  'L104 44 L110 10 L116 64 L122 36 L128 44 L150 44 L156 22 L162 58 L168 44 ' +
  'L190 44 L196 14 L202 62 L208 32 L214 44 L236 44 L242 20 L248 56 L254 44 L290 44 ' +
  'L400 44 ' +
  'L406 44 L412 16 L418 62 L424 34 L430 44 L452 44 L458 24 L464 54 L470 44 L490 44 ' +
  'L500 44 L520 44 L520 66 L600 66';

interface Beat {
  readonly name: string;
  readonly tone: 'wait' | 'run' | 'info' | 'idle';
  readonly note: string;
  readonly t: number;
}

const BEATS: readonly Beat[] = [
  { name: 'spawning', tone: 'wait', note: 'asked for', t: 150 },
  { name: 'running', tone: 'run', note: 'output flowing', t: 500 },
  { name: 'idle', tone: 'info', note: '~10s of quiet', t: 1450 },
  { name: 'running', tone: 'run', note: 'speaks again', t: 1950 },
  { name: 'exited', tone: 'idle', note: 'process ended', t: 2450 },
];

function Heartbeat() {
  return (
    <SignatureStage caption="The heartbeat" label="A work session's status drawn as the process lives it" className="ehs-sess">
      <svg className="ehs-sess__trace" viewBox="0 0 600 76" preserveAspectRatio="none" aria-hidden>
        <path className="ehs-sess__baseline" d="M0 44 L600 44" />
        <path className="ehs-sess__line ehs-draw" d={TRACE} pathLength={1000} style={at(150)} />
      </svg>
      <ol className="ehs-sess__beats" aria-label="Status, in order">
        {BEATS.map((beat, index) => (
          <li key={`${beat.name}-${index}`} className="ehs-sess__beat ehs-light" style={at(beat.t)}>
            <span className={`ehs-chip ehs-chip--${beat.tone}`}>
              <span className="ehs-dot" aria-hidden />
              {beat.name}
            </span>
            <span className="ehs-sess__why">{beat.note}</span>
          </li>
        ))}
      </ol>
      <div className="ehs-sess__bands" aria-label="Where each status files">
        <span className="ehs-sess__band ehs-grow" style={at(300)}>
          To Do
        </span>
        <span className="ehs-sess__band ehs-sess__band--live ehs-grow" style={at(700)}>
          In Progress
        </span>
        <span className="ehs-sess__band ehs-grow" style={at(2500)}>
          Done
        </span>
      </div>
      <ul className="ehs-sess__verbs" aria-label="What a person can do about it">
        <li className="ehs-in" style={at(2900)}>
          <span className="ehs-chip ehs-chip--brass">✓ tick</span> files it under Done. The process keeps running.
        </li>
        <li className="ehs-in" style={at(3150)}>
          <span className="ehs-chip ehs-chip--block">terminate</span> ends the process. It files under Done because it
          truly finished.
        </li>
        <li className="ehs-in" style={at(3400)}>
          <span className="ehs-chip ehs-chip--info">↺ resume</span> relaunches an ended run with its whole
          conversation. It starts again at spawning.
        </li>
      </ul>
      <p className="ehs-note">
        A session that <em>failed</em> through a crash, running out of memory or a server restart stays in In
        Progress, because it never finished. Nobody writes these statuses. The server reads them off the terminal.
      </p>
    </SignatureStage>
  );
}

export const WORK_SESSION_HELP: KindHelpModule = {
  kind: 'work_session',

  story: {
    logline: 'An agent at a real terminal, doing the work where you can watch it happen.',
    opening: (
      <>
        <p>
          A <strong>work session</strong> is one agent process running in a terminal the server hosts. At spawn it
          is bound to a teammate, the tasks it was launched on, a working directory, a model and an access posture.
          You can watch it scroll, type into it if you are allowed to, message it while it works, and read back
          afterwards what it said and what it ran.
        </p>
        <p>
          Before sessions, an agent run was a process on someone&rsquo;s machine. Nobody else could see it, and it was
          gone when the window closed. A session gives the run an address. Tasks can see who is working on them,
          other sessions can talk to it, and a finished run can be resumed with its conversation intact.
        </p>
      </>
    ),
    beats: [
      {
        eyebrow: 'How it is born',
        title: 'Launched, never created',
        body: (
          <p>
            Sessions have no &ldquo;New&rdquo; button. They are launched, either an agent on some work or a plain
            terminal. The server-hosted terminal is the only way a session starts, and the server always computes its
            working directory, so no caller can point an agent at an arbitrary path. A session spawned by another
            session inherits its spawner&rsquo;s access posture and credential unless told otherwise.
          </p>
        ),
      },
      {
        eyebrow: 'The signature',
        title: 'Status is observed, never chosen',
        body: (
          <>
            <p>
              A session&rsquo;s status comes from the process. <em>Spawning</em> is the brief gap between asking and
              starting. <em>Running</em> means output is flowing. <em>Idle</em> means it spoke and then went quiet for
              about ten seconds. That is a fact about the terminal, not a claim that it is waiting for you, and the
              next line of output flips it back. <em>Exited</em> and <em>failed</em> are the two endings. The list
              opens on In Progress because the question it answers is what is running now.
            </p>
            <Heartbeat />
          </>
        ),
      },
      {
        eyebrow: 'Three verbs, three questions',
        title: 'Done is not dead',
        body: (
          <p>
            The tick and Terminate sit side by side because they answer different questions. <strong>Terminate</strong>{' '}
            ends the process. <strong>The tick</strong> ends the row&rsquo;s claim on your attention. The session files
            under Done while its terminal keeps streaming, so you can come back to it, and ticking again reopens it.
            Once a run has ended, the row offers <strong>Resume</strong>. It relaunches the agent against the exact
            conversation its provider recorded, never a fresh start dressed up as one. <em>Continue</em> is the other
            path: a new session on a &ldquo;Continue:&rdquo; task.
          </p>
        ),
      },
      {
        eyebrow: 'Where it works',
        title: 'A lane of its own',
        body: (
          <p>
            A session works in one of three places. A <em>project</em> workdir is the shared checkout. A{' '}
            <em>scratch</em> workdir is a server-managed directory with no repository. A <em>worktree</em> is its own
            lane: an isolated checkout on a <code>tm8/&lt;worktree-id&gt;</code> branch, cut from the project&rsquo;s
            default branch or an exact <code>--base-ref</code>. Lanes are how many agents change one repository at
            once without stepping on each other. Checkpoints commit the lane&rsquo;s work in progress, and a rollback
            can return to one.
          </p>
        ),
      },
      {
        eyebrow: 'How it hears you',
        title: 'Messages arrive as turns',
        body: (
          <p>
            A message posted to a live session is typed into its terminal as a new prompt. While it is still spawning
            or resuming, prompts wait in a short queue and are delivered when the terminal attaches. A message to a
            session that has ended is still stored on its anchor, but nothing waits to type it into a run that may never
            come. A session
            is never handed its own words. For a coordinated worker, the parent session is the return address its
            results go back to.
          </p>
        ),
      },
    ],
    lifecycle: [
      { name: 'Spawning', note: 'Asked for, not yet started. The sub-second gap, filed under To Do.' },
      { name: 'Running', note: 'Output is flowing. Filed under In Progress, and the list opens here.' },
      { name: 'Idle', note: 'Spoke, then went quiet for about ten seconds. Still live, still In Progress.' },
      { name: 'Exited', note: 'The process ended, by finishing or by Terminate. Filed under Done. Resume can bring it back.' },
      { name: 'Failed', note: 'It ended badly. A crash, out of memory or server restart stays In Progress. Resume still applies.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal, a session is something you start, watch, read back and end. The reads are unusually
        honest. The transcript is what the agent said, the journal is what it ran through <code>tm8</code>, and the
        launch record is exactly what it was told. Each one says which it is and never stands in for another.
      </p>
    ),
    scenes: [
      {
        title: 'Launch',
        narrative: (
          <p>
            <code>tm8 session spawn</code> is for when you know who should do the work. <code>--workdir worktree</code>{' '}
            gives the session its own lane, and <code>--context</code> adds launch-manifest context, not a prompt.{' '}
            <code>tm8 session dispatch</code> is for when you do not know who. You name the work, and the Space&rsquo;s
            dispatcher picks the teammate. The first dispatch in a Space is the slow one, because it may have to start
            the dispatcher first.
          </p>
        ),
        commands: ['session spawn', 'session dispatch'],
        demo: [
          'tm8 session spawn --teammate <team-member-id> --task <task-id> --workdir worktree --reasoning-effort high',
          '# or hand it over and let the dispatcher decide who',
          'tm8 session dispatch <task-id> --note "touches the billing schema"',
        ],
      },
      {
        title: 'Watch and steer',
        narrative: (
          <p>
            <code>tm8 session liveness</code> is a point-in-time observation of which sessions have a live terminal on
            this server right now. Trust it over a stored status, because a crashed session can keep its last status
            forever. Attach in <em>view</em> or <em>drive</em> mode. Sharing has two independent dials, who may watch
            and who may type, and opening one never implies the other.
          </p>
        ),
        commands: ['session liveness', 'session attach', 'session share'],
        demo: ['tm8 session liveness', 'tm8 session attach <work-session-id> --mode view', 'tm8 session share <work-session-id> --share space'],
      },
      {
        title: 'Read it back',
        narrative: (
          <p>
            The <strong>transcript</strong> is the agent&rsquo;s own turns, with tool names but never tool bodies,
            because file contents and secrets travel there. The <strong>journal</strong> is every <code>tm8</code>{' '}
            command it ran and what came back, with byte-derived token estimates. The <strong>launch</strong> record is
            the exact bytes of its system and first prompts, read back from storage and never recomposed.
          </p>
        ),
        commands: ['session transcript', 'session journal', 'session launch'],
        demo: ['tm8 session transcript <work-session-id> --last 20', 'tm8 session journal <work-session-id> --limit 50', 'tm8 session launch <work-session-id>'],
      },
      {
        title: 'Save points and endings',
        narrative: (
          <p>
            A checkpoint commits the lane&rsquo;s whole work in progress and returns the ref. A clean tree is a success
            that creates nothing. Rolling back discards tracked work, but the rolled-over commits stay reachable in the
            reflog. Untracked files are the one unrecoverable loss, so they need <code>--force</code>. Terminate ends
            the process, and Resume brings an ended run back with its conversation.
          </p>
        ),
        commands: ['session checkpoint', 'session rollback', 'session terminate', 'session resume'],
        demo: [
          'tm8 session checkpoint <work-session-id> --message "before the schema change"',
          'tm8 session rollback <work-session-id> --to <checkpoint-ref>',
          'tm8 session terminate <work-session-id> --yes',
          'tm8 session resume <work-session-id>',
        ],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A session is the busiest junction in the graph. Look first for <strong>working on</strong> (its tasks) and{' '}
        <strong>acting as</strong> (the teammate responsible for it). Then comes where it runs: its project, its
        worktree lane, and the credential and container it runs on. Last are the edges the server draws as it works,
        like who it messaged, what was created in it and who dispatched it.
      </p>
    ),
    notes: {
      working_on: 'The tasks this session was launched on. Written at spawn, and the reason a task can show who is on it.',
      participates_in: 'The teammate responsible for this session.',
      in_project: 'The Space’s project whose folder the session works in.',
      in_worktree: 'The isolated lane it works in, on its own tm8/<worktree-id> branch.',
      'dispatched_by:outgoing': 'The dispatcher session that chose the teammate and spawned this one. Its reasoning is a message on the task.',
      'dispatched_by:incoming': 'Sessions this dispatcher spawned.',
      messaged: 'Drawn by the server from message deliveries: which sessions this one addressed, and which addressed it.',
      'created_in:incoming': 'Entities created during this session. The client asserts this; authored here is the verified form.',
      'authored_from:incoming': 'Messages, memories, artifacts and forms the server recorded as written from inside this session.',
      runs_on: 'The credential this session runs on. Written only by the credential binding, never by hand.',
      selected_profile: 'The interaction profile pinned at launch, fixed for the session’s life.',
      runs_in: 'The container its process tree runs inside.',
      drives: 'A container it operates through tools, without running inside it.',
      triggered_by: 'The loop whose firing started this session.',
    },
    spotlight: ['task', 'team_member', 'project', 'worktree'],
  },
};
