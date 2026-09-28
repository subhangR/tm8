/**
 * TASK — Entity Help, Wave 1 (task 01a0e7d6).
 *
 * Fact sources, so a later edit can re-check them rather than trust the prose:
 *   seven statuses → four categories, and the two rulings   server facade/status.ts (mirrors migration 147)
 *   only complete_task writes done; completed_by + award    migration 151 complete_task / set_work_state
 *   criteria + pr_merged gate apply to ANY move into done   migration 151 default_transition_conditions
 *   blocked is set by hand; the blocked BADGE is derived    migration 151 set_work_state; collections.ts badges
 *   ready to pull = to_do with no unresolved hard depends   server handlers/collections.ts
 *   a launch derives a task for a non-task subject          migrations 064, 200 derive_task_for_entity
 *   spawn writes working_on + assigned_to, starts to_do     migration 267
 *   per-type status vocabularies                            migration 132 task_workflows
 *
 * THE SIGNATURE is the gate: a hand-written `done` is refused, criteria tick,
 * the tracked PR merges, and only then does `task complete` land its stamp.
 */
import type { KindHelpModule } from '../types';
import { SignatureStage, at } from './SignatureStage';

const CRITERIA: readonly { text: string; t: number }[] = [
  { text: 'arm64 image builds in CI', t: 1000 },
  { text: 'smoke test passes on the new runner', t: 1400 },
  { text: 'release notes mention the new platform', t: 1800 },
];

function TheGate() {
  return (
    <SignatureStage caption="Crossing the finish line" label="A task passing its completion gate" className="ehs-task">
      <div className="ehs-task__card">
        <div className="ehs-task__head">
          <span className="ehs-task__title">Ship the arm64 image</span>
          <span className="ehs-chip ehs-chip--wait">in review</span>
        </div>

        <p className="ehs-task__refusal ehs-in" style={at(150)}>
          <code>tm8 task transition … done</code>
          <span className="ehs-chip ehs-chip--block">refused · use the complete command</span>
        </p>

        <ul className="ehs-task__criteria" aria-label="Acceptance criteria, all ticked">
          {CRITERIA.map((c) => (
            <li key={c.text} className="ehs-task__criterion ehs-light" style={at(c.t)}>
              <span className="ehs-task__box" aria-hidden>
                <span className="ehs-task__tick ehs-pop" style={at(c.t)}>
                  ✓
                </span>
              </span>
              {c.text}
            </li>
          ))}
        </ul>

        <div className="ehs-task__gate ehs-light" style={at(2300)}>
          <span className="ehs-mono">gate · pr_merged</span>
          <span className="ehs-task__pr">
            <span className="ehs-chip ehs-chip--run">tracked PR merged</span>
            <span className="ehs-chip ehs-chip--run">CI green</span>
          </span>
        </div>

        <div className="ehs-task__finish">
          <code className="ehs-task__cmd ehs-in" style={at(2800)}>
            tm8 task complete … --by &lt;actor&gt;
          </code>
          <span className="ehs-task__stamp" style={at(3050)}>
            Done
          </span>
        </div>
        <div className="ehs-task__after ehs-in" style={at(3500)}>
          <span className="ehs-chip">completed_by → the completer</span>
          <span className="ehs-chip ehs-chip--brass">award · the task&rsquo;s points</span>
        </div>
      </div>
      <p className="ehs-note">
        Writing <em>done</em> by hand is refused. Every criterion is ticked, the tracked pull request has merged with
        green CI, and only then does <code>task complete</code> write it, along with who finished the work.
      </p>
    </SignatureStage>
  );
}

export const TASK_HELP: KindHelpModule = {
  kind: 'task',

  story: {
    logline: 'A piece of work that carries its own finish line.',
    opening: (
      <>
        <p>
          A <strong>task</strong> is the unit of work in tm8. It has a title, a status, the people and sessions on it,
          and, when it is ready to be proved, a list of acceptance criteria. Almost everything else points back at
          tasks: a session works <em>on</em> one, a pull request is <em>tracked</em> by one, and a memory is{' '}
          <em>remembered</em> by one so the next agent starts out knowing it.
        </p>
        <p>
          Anyone can type &ldquo;done&rdquo;, and that is the problem a task solves. Here, done is a claim the task
          checks for itself: its criteria have to be ticked, its merge gate has to agree, and one command writes it.
          That is why a finished task can be trusted, even when nobody watched it finish.
        </p>
      </>
    ),
    beats: [
      {
        eyebrow: 'The signature',
        title: 'Done is a verdict, not a status',
        body: (
          <>
            <p>
              <code>tm8 task complete</code> is the only operation that may write done.{' '}
              <code>task transition … done</code> is refused by name. Two checks guard every move into done. Every
              acceptance criterion must be ticked, and if the task opted into the <code>pr_merged</code> gate, it must
              have a tracked pull request that has merged with green CI. When they pass, the completer is recorded as a{' '}
              <em>completed by</em> edge. If the task carries a points estimate, those points are awarded to them.
            </p>
            <TheGate />
          </>
        ),
      },
      {
        eyebrow: 'Why the tabs read as they do',
        title: 'Seven statuses, four places',
        body: (
          <>
            <p>
              A task&rsquo;s status is one of seven words, and each files under one of four tabs. <em>Open</em> and{' '}
              <em>pulled</em> both sit in To Do, because claimed is not started. <em>Working</em>,{' '}
              <em>in review</em> and <em>blocked</em> sit in In Progress, because stuck is not the same as not yet
              started. <em>Done</em> and <em>cancelled</em> each have their own tab.
            </p>
            <p>
              <em>Blocked</em> is a status someone sets by hand. The blocked <em>badge</em> is different. It is derived
              from the task&rsquo;s unresolved hard dependencies, so an open task can wear it. A task in To Do with no
              unresolved hard dependencies is what the <em>Ready to pull</em> filter shows. A Space can also limit
              which statuses each task type may use.
            </p>
          </>
        ),
      },
      {
        eyebrow: 'How work reaches it',
        title: 'Run it, and the graph fills itself in',
        body: (
          <p>
            <strong>Run</strong> opens the launch configuration (teammate, model, project, mode) rather than spawning
            blind. <strong>Coordinate</strong> is the same door with a coordinator at the helm. When the session
            starts, the server writes the session&rsquo;s <em>working on</em> edge and the task&rsquo;s{' '}
            <em>assigned to</em> edge, and moves a To Do task into its in-progress state. Launch anything that is not a
            task and the server derives one (&ldquo;Work on: …&rdquo;, linked by <em>launches</em>), so every session
            has a task to answer to.
          </p>
        ),
      },
      {
        eyebrow: 'What it keeps',
        title: 'A task remembers what it touched',
        body: (
          <p>
            Linking a pull request or a commit with <code>tm8 task link-pr</code> or <code>link-commit</code> makes the
            task <em>track</em> it. From then on its state, CI and mergeability are polled for you, which is what the
            gate reads. Memories the task <em>remembers</em> are handed to every session spawned on it, and the skills
            it <em>equips</em> ride into their manifests. The task becomes the briefing.
          </p>
        ),
      },
    ],
    lifecycle: [
      { name: 'Open', note: 'Waiting. With no unresolved hard dependencies, it shows up as ready to pull.' },
      { name: 'Pulled', note: 'Claimed, not yet started, so it stays under To Do.' },
      { name: 'Working', note: 'Someone is on it. A Run moves a To Do task here and records who.' },
      { name: 'In review', note: 'Up for review. Blocked sits in In Progress too, set by hand when it is stuck.' },
      { name: 'Done', note: 'Written only by task complete, once criteria and gate agree. Cancelled is the other way out.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        Working a task from a terminal is a loop of orient, act, prove. The writes that decide the outcome (tick, gate,
        complete) carry the version you read, so two agents racing on one task produce a version conflict rather than
        a silent overwrite. <code>tm8 entity context</code> returns both the version and the exact tick command, so
        the first read hands you the last write.
      </p>
    ),
    scenes: [
      {
        title: 'Orient before touching it',
        narrative: (
          <p>
            One bounded call returns the summary, the hierarchy, recent messages, the acceptance criteria with their
            ids, and the actions you may take with the current version. <code>tm8 action list</code> answers the
            narrower question of what you are allowed to do right now.
          </p>
        ),
        commands: ['entity context', 'action list'],
        demo: ['# the acceptance section carries criterion ids and the tick command', 'tm8 entity context <task-id>', 'tm8 action list --for <task-id>'],
      },
      {
        title: 'Move it along',
        narrative: (
          <p>
            <code>tm8 task transition</code> moves a task anywhere short of done, using the contract&rsquo;s exact
            spellings (<code>in_review</code>, not &ldquo;in review&rdquo;). The server owns the timestamp, so lifecycle
            history cannot be backdated. <code>tm8 task axis</code> files the task along the Space&rsquo;s own
            taxonomies. An axis value outside the declared list is refused.
          </p>
        ),
        commands: ['task transition', 'task axis', 'space task-axis list'],
        demo: ['tm8 task transition <task-id> working', 'tm8 space task-axis list', 'tm8 task axis <task-id> type bug'],
      },
      {
        title: 'Prove it, then finish it',
        narrative: (
          <p>
            Tick criteria by id. The server merges ticks by id, so you never restate the list. Link the pull request
            so it is tracked. If the task should wait for a merge, set the <code>pr_merged</code> gate. Then complete
            it, naming who did the work. Unticked criteria refuse the completion and tell you which ones.
          </p>
        ),
        commands: ['task tick', 'task link-pr', 'task link-commit', 'task gate', 'task complete'],
        demo: [
          'tm8 task tick <task-id> build smoke notes --expect-version 7',
          'tm8 task link-pr <task-id> https://github.com/org/repo/pull/412',
          'tm8 task gate <task-id> pr_merged --expect-version 8',
          'tm8 task complete <task-id> --expect-version 9 --by <actor-id>',
        ],
      },
      {
        title: 'Bring work in, send work out',
        narrative: (
          <p>
            A GitHub issue can be imported once as a task. Nothing is ever written back, and a pull request URL is
            refused because pull requests are linked live instead. To get it worked, spawn a session for a teammate
            you choose, or dispatch it and let the Space&rsquo;s dispatcher pick who.
          </p>
        ),
        commands: ['task import-issue', 'session spawn', 'session dispatch'],
        demo: [
          'tm8 task import-issue https://github.com/org/repo/issues/88',
          'tm8 session spawn --teammate <team-member-id> --task <task-id> --workdir worktree',
          '# or let the dispatcher choose',
          'tm8 session dispatch <task-id> --note "needs someone who knows the CLI"',
        ],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A task sits at the centre of more named relations than almost any other kind. Start with the three that
        answer who and what: <strong>assigned to</strong> (the people and teammates it belongs to),{' '}
        <strong>worked on by</strong> (the sessions on it right now) and <strong>tracks</strong> (the pull requests
        and commits its gate reads). The rest record where it came from and what it leaves behind.
      </p>
    ),
    notes: {
      assigned_to: 'Who the task belongs to. A Run writes it for the teammate it launches, marked as coming from the spawn.',
      'working_on:incoming': 'The sessions (and people) on it right now. Written when a session spawns with the task, and moved by status changes.',
      tracks: 'Pull requests and commits linked with task link-pr or link-commit. Tracking is polled for you, and the pr_merged gate reads it.',
      completed_by: 'Written by task complete, one edge per completer. It is also who any points award goes to.',
      depends_on: 'Sequencing. An unresolved hard dependency shows as the blocked badge and keeps the task out of Ready to pull. It never sets the blocked status itself.',
      'derived_from:outgoing': 'This task was made by the server to launch that entity. A session on a doc or a chat still has a task to answer to.',
      remembers: 'The task’s memory working set. Every session spawned on the task receives these memories.',
      equips: 'Skills and spells that ride into the manifest of every session launched on this task.',
      in_project: 'The Space’s project this work belongs to.',
      'pulled:incoming': 'A member’s local adoption of the task, with the version they pulled. It is a separate thing from the pulled status.',
      consumes: 'An input the task reads, written when a Craft blueprint is materialised.',
      produces: 'An output the task is expected to make, written the same way.',
      triggered_by: 'The loop whose firing created this task.',
      approval_requested_from: 'Registered for approvals, and inert in this version.',
      approved_by: 'Registered for approval verdicts, and inert in this version.',
    },
    spotlight: ['team_member', 'work_session', 'pull_request', 'project'],
  },
};
