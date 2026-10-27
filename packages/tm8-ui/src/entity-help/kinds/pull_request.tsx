/**
 * PULL REQUEST — the forge's verdict, mirrored into the graph.
 *
 * Every claim here is read from this build:
 *   birth       `link_pull_request` (017:534-579): find-or-create by
 *               (space, provider, repo, number), state 'open', title
 *               'repo #n', then a task ⟶ PR `tracks` edge; the CLI adds a
 *               best-effort `authored_from` edge to the calling session.
 *   states      open | draft | merged | closed (001:623); GitHub's
 *               `merged_at` wins over `closed` (tracking/github.ts).
 *   observing   the forge watcher (90 s, open/draft PRs some task tracks)
 *               writes the CI rollup; the observer (60 s) drains
 *               `tracking refresh` requests (tracking/loops.ts, observer.ts).
 *   the gate    `pr_merged` refuses a done move with no tracked PR, or with
 *               any tracked PR unmerged or CI-red (151:229-248).
 *   pr merge    refuses unless the row is open, not conflicted, not CI-red,
 *               and the caller holds their own GitHub credential
 *               (facade/services/w2/tracking-write.ts).
 *   nudges      CI failure and merge conflict are posted to the PR's owning
 *               session (tracking/nudges.ts).
 */
import type { CSSProperties } from 'react';
import { Stagger } from '../motion/Reveal';
import type { KindHelpModule } from '../types';

/* ── THE GATE, frame by frame ─────────────────────────────────────────────
   The signature moment: one task gated on `pr_merged`, asked to complete
   four times while its pull request moves. The frames arrive in order like
   a strip of evidence; under reduced motion they are simply all there, and
   the order of the list carries the same story. Colour is never the only
   signal: every mark has its word beside it. */

type Tone = 'idle' | 'run' | 'wait' | 'block' | 'merged';

const TONE: Readonly<Record<Tone, string>> = {
  idle: 'var(--pn-idle)',
  run: 'var(--pn-run)',
  wait: 'var(--pn-wait)',
  block: 'var(--pn-block)',
  merged: 'var(--pn-pr-merged)',
};

interface GateFrame {
  readonly pr: { readonly word: string; readonly tone: Tone };
  readonly ci: { readonly word: string; readonly tone: Tone };
  readonly verdict: string;
  readonly open: boolean;
}

const GATE_FRAMES: readonly GateFrame[] = [
  {
    pr: { word: 'no PR tracked', tone: 'idle' },
    ci: { word: 'no checks', tone: 'idle' },
    verdict: 'Refused: no tracked pull request on this task.',
    open: false,
  },
  {
    pr: { word: 'open', tone: 'run' },
    ci: { word: 'CI green', tone: 'run' },
    verdict: 'Refused: green is not merged.',
    open: false,
  },
  {
    pr: { word: 'merged', tone: 'merged' },
    ci: { word: 'CI red', tone: 'block' },
    verdict: 'Refused: a merge with red checks still counts as red.',
    open: false,
  },
  {
    pr: { word: 'merged', tone: 'merged' },
    ci: { word: 'CI green', tone: 'run' },
    verdict: 'The gate lifts. The task may complete.',
    open: true,
  },
];

const frameStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  alignItems: 'center',
  gap: 'var(--pn-space-3)',
  padding: 'var(--pn-space-3) var(--pn-space-4)',
  border: '1px solid var(--pn-line-2)',
  borderRadius: 'var(--pn-r-md)',
  background: 'var(--pn-card)',
};

const markStyle = (tone: Tone): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--pn-space-2)',
  fontFamily: 'var(--pn-mono)',
  fontSize: 'var(--pn-fs-fine)',
  letterSpacing: 'var(--pn-track-label)',
  color: 'var(--pn-ink-2)',
  ['--eh-pr-tone' as string]: TONE[tone],
});

const dotStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 'var(--pn-r-pill)',
  background: 'var(--eh-pr-tone)',
  flex: 'none',
};

function Mark({ word, tone }: { word: string; tone: Tone }) {
  return (
    <span style={markStyle(tone)}>
      <span aria-hidden style={dotStyle} />
      {word}
    </span>
  );
}

function GateReel() {
  return (
    <div data-testid="pull-request-gate-reel" style={{ marginTop: 'var(--pn-space-4)' }}>
      <span className="eh-eyebrow">tm8 task complete, asked four times</span>
      <Stagger step={260} start={180}>
        {GATE_FRAMES.map((frame, index) => (
          <div
            key={index}
            style={{
              ...frameStyle,
              marginTop: 'var(--pn-space-2)',
              borderColor: frame.open ? 'var(--pn-pr-merged)' : 'var(--pn-line-2)',
              background: frame.open ? 'var(--pn-pr-merged-soft)' : 'var(--pn-card)',
            }}
          >
            <span
              aria-hidden
              style={{
                fontFamily: 'var(--pn-mono)',
                fontSize: 'var(--pn-fs-label)',
                color: frame.open ? 'var(--pn-pr-merged)' : 'var(--pn-ink-3)',
              }}
            >
              {frame.open ? '✓' : '✕'}
            </span>
            <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--pn-space-4)' }}>
              <Mark {...frame.pr} />
              <Mark {...frame.ci} />
              <span style={{ color: frame.open ? 'var(--pn-ink)' : 'var(--pn-ink-2)', fontWeight: frame.open ? 600 : 400 }}>
                {frame.verdict}
              </span>
            </span>
          </div>
        ))}
      </Stagger>
    </div>
  );
}

export const PULL_REQUEST_HELP: KindHelpModule = {
  kind: 'pull_request',

  story: {
    logline: 'The forge decides when code has landed, and this is where tm8 hears the verdict.',

    opening: (
      <>
        <p>
          A pull request here is a mirror. The real one lives on GitHub, with its branch, its checks and its merge
          button. This entity holds what tm8 last saw of it: which repository and number, whether it is open, draft,
          merged or closed, whether CI is passing, failing or still running, and whether it merges cleanly.
        </p>
        <p>
          Without the mirror, a task is done when someone says so. An agent can finish a branch, open a PR, mark
          the task complete and walk away while the checks go red behind it. Now the task can point at the PR, and
          the PR tells the task, and the agent that wrote it, what actually happened.
        </p>
      </>
    ),

    beats: [
      {
        eyebrow: 'How it is born',
        title: 'Linked, not authored',
        body: (
          <p>
            A pull request arrives by being linked. An agent runs <code>tm8 task link-pr</code> with the URL, and the
            server finds or makes the mirror by repository and number, so linking the same PR from two tasks gives
            one entity with two <code>tracks</code> edges. It starts life as <em>open</em> with a placeholder title;
            the real title arrives with the first observation. The CLI also records the session it was linked from,
            which is how the right agent gets told when something breaks.
          </p>
        ),
      },
      {
        eyebrow: 'Why it stays true',
        title: 'Watched, not remembered',
        body: (
          <p>
            A watcher polls GitHub every ninety seconds for every open or draft PR a task tracks, and rolls the
            check runs on its head commit into one word. Any failing check makes it <em>failing</em>; any check
            still running makes it <em>pending</em>; no checks at all is left unknown rather than called green.
            When you cannot wait, <code>tm8 tracking refresh</code> queues an immediate re-read. Merged and closed
            PRs drop out of the watch: their story is over.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'The gate',
        body: (
          <>
            <p>
              A task set to <code>pr_merged</code> with <code>tm8 task gate</code> cannot move to done until every
              pull request it tracks is merged and none of them is CI-red. The check sits on the status move
              itself rather than on one command, so every writer of the status is asked it.
            </p>
            <GateReel />
          </>
        ),
      },
      {
        eyebrow: 'When it breaks',
        title: 'The PR comes looking for you',
        body: (
          <p>
            When a check turns red, or the branch starts to conflict, tm8 does not wait to be asked. It writes a
            message straight into the session that made the PR, carrying the failing check, the commit and the tail
            of the job log. The agent learns about its own red build in its own terminal, while the context is
            still warm.
          </p>
        ),
      },
      {
        eyebrow: 'How it ends',
        title: 'Merged is a fact, not a claim',
        body: (
          <p>
            <code>tm8 pr merge</code> lands it on the forge as you, with your own GitHub credential, and only when
            the mirror says it is open, conflict-free and not red. Then tm8 re-reads the PR and records the merge the
            way it records everything else: by observing it. A PR closed without merging stays <em>closed</em>, and
            a gated task stays open.
          </p>
        ),
      },
    ],

    lifecycle: [
      { name: 'Linked', note: 'A task tracks the URL. Open, placeholder title, nothing observed yet.' },
      { name: 'Draft', note: 'The forge says not ready yet. Watched exactly like an open PR.' },
      { name: 'Open', note: 'Watched every ninety seconds: CI rollup, mergeability, head commit.' },
      { name: 'Merged', note: 'Recorded when observed. Gated tasks may complete; the watch ends.' },
      { name: 'Closed', note: 'Given up without a merge. Gated tasks stay refused.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal you rarely create a pull request; you attach one. The work is linking it to the task it
        delivers, deciding whether that task should wait on it, and nudging the mirror when the forge moves faster
        than the watcher.
      </p>
    ),

    scenes: [
      {
        title: 'Link it the moment it exists',
        narrative: (
          <p>
            Open the PR on GitHub, then link it before doing anything else. An unlinked PR is invisible: no status
            chip, no CI nudges, and no gate can ever see it. Linking twice is safe; the mirror is found by
            repository and number.
          </p>
        ),
        commands: ['task link-pr'],
        demo: [
          '# the forge has the PR; now tm8 does too',
          'tm8 task link-pr <task-id> https://github.com/acme/api/pull/412',
        ],
      },
      {
        title: 'Make the task wait',
        narrative: (
          <p>
            A gate is opt-in and per task. Set <code>pr_merged</code> when the task is only done once code has
            landed; after that, a completion attempt with an unmerged or red PR is refused with a named reason.
          </p>
        ),
        commands: ['task gate', 'task complete'],
        demo: [
          'tm8 task gate <task-id> pr_merged --expect-version 3',
          '# refused until every tracked PR is merged and none is CI-red',
          'tm8 task complete <task-id> --expect-version 4 --by <actor-id>',
        ],
      },
      {
        title: 'Read the forge now, then land it',
        narrative: (
          <p>
            The watcher is patient; you may not be. Queue a refresh to pull the latest state, then merge through tm8
            so the refusals the mirror knows about are checked before GitHub is asked.
          </p>
        ),
        commands: ['tracking refresh', 'pr merge'],
        demo: [
          'tm8 tracking refresh <pull-request-id>',
          '# open, clean and not red, or the merge is refused here',
          'tm8 pr merge <pull-request-id>',
        ],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A pull request hangs off the task it delivers. Look for the <code>tracks</code> edge first: it is the one
        the gate, the chips and the watcher all read. The rest place the PR in space: which project, which
        worktree, which session opened it.
      </p>
    ),

    notes: {
      tracks: 'A task pointing at the PR that delivers it. The watcher only watches PRs that some task tracks.',
      authored_from: 'The session the PR was made during, recorded by the server. CI failures and merge conflicts are posted there.',
      in_worktree: 'The worktree the PR is associated with in this Space.',
      in_project: 'The project the PR is counted under.',
      attached_to: 'The PR pinned as context onto another entity.',
    },

    spotlight: ['task', 'work_session', 'worktree', 'project'],
  },
};
