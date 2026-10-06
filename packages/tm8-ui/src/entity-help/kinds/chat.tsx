/**
 * CHAT — Entity Help, Wave 1 (task 01a0e7d6).
 *
 * Fact sources, so a later edit can re-check them rather than trust the prose:
 *   runtime cold|live|stopped, turn idle|queued|running   contract.ts ChatState; entity-read.ts folds turnState
 *   one warm headless process, --resume on stopped        execution ClaudeHeadlessAdapter; server chat/orchestrator
 *   pinned at start: teammate, model, workdir, project    migration 176 start_chat; cli commands/chat.ts
 *   mode is the default; a turn may carry its own         migration 153 chat_per_turn_mode; messages.post `mode`
 *   project = the folder as it stands; scratch = own dir  contract ChatWorkdir; chat/handlers.ts
 *   self-delivery guard keyed on source, not author       migration 176 (chat turn enqueue)
 *   workers a chat starts take it as parent               migration 178; chat/scope.ts
 *
 * THE SIGNATURE is "two clocks": a chat's runtime and its turn are different
 * facts, and `chat list` prints both. The scene runs one turn and lets each
 * clock move on its own.
 */
import type { KindHelpModule } from '../types';
import { SignatureStage, at } from './SignatureStage';

interface Step {
  readonly name: string;
  readonly t: number;
  readonly tone: 'idle' | 'wait' | 'run' | 'info';
}

function Clock({ title, steps }: { title: string; steps: readonly Step[] }) {
  return (
    <div className="ehs-clock">
      <span className="ehs-clock__title">{title}</span>
      <ol className="ehs-clock__track" aria-label={`${title}: ${steps.map((s) => s.name).join(', then ')}`}>
        {steps.map((step, index) => (
          <li
            key={`${step.name}-${index}`}
            className={`ehs-clock__step ehs-light${index === steps.length - 1 ? ' ehs-clock__step--now' : ''}`}
            style={at(step.t)}
          >
            {index > 0 ? <span className="ehs-clock__wire ehs-grow" style={at(step.t - 260)} aria-hidden /> : null}
            <span className={`ehs-chip ehs-chip--${step.tone}`}>
              <span className="ehs-dot" aria-hidden />
              {step.name}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TwoClocks() {
  return (
    <SignatureStage caption="Two clocks, one turn" label="A chat turn moving the turn clock and the runtime clock" className="ehs-chat">
      <div className="ehs-chat__grid">
        <ol className="ehs-chat__thread" aria-label="Transcript">
          <li className="ehs-chat__msg ehs-chat__msg--you ehs-in" style={at(0)}>
            <span className="ehs-chat__who">You</span>
            Why does the arm64 build fail on main?
          </li>
          <li className="ehs-chat__msg ehs-chat__msg--agent ehs-in" style={at(1300)}>
            <span className="ehs-chat__who">Teammate</span>
            <span className="ehs-chat__typing" style={at(1300)} aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="ehs-chat__reply ehs-in" style={at(2500)}>
              The image pins an x86 wheel. I swapped it for the arm64 build and re-ran the job.
            </span>
          </li>
        </ol>
        <div className="ehs-chat__clocks">
          <Clock
            title="Turn"
            steps={[
              { name: 'idle', t: 0, tone: 'idle' },
              { name: 'queued', t: 450, tone: 'wait' },
              { name: 'running', t: 1250, tone: 'run' },
              { name: 'idle', t: 2800, tone: 'idle' },
            ]}
          />
          <Clock
            title="Runtime"
            steps={[
              { name: 'cold', t: 0, tone: 'idle' },
              { name: 'live', t: 950, tone: 'info' },
            ]}
          />
        </div>
      </div>
      <div className="ehs-chat__pins ehs-in" style={at(3100)}>
        <span className="ehs-chip ehs-chip--brass">teammate</span>
        <span className="ehs-chip ehs-chip--brass">model</span>
        <span className="ehs-chip ehs-chip--brass">workdir</span>
        <span className="ehs-chat__pin-note">fixed at start</span>
        <span className="ehs-chip">mode</span>
        <span className="ehs-chat__pin-note">the default, and a turn may carry its own</span>
      </div>
      <p className="ehs-note">
        After the turn the turn clock is back at idle and the runtime stays live. The process is still there and
        still holds the context, so the next message starts warm.
      </p>
    </SignatureStage>
  );
}

export const CHAT_HELP: KindHelpModule = {
  kind: 'chat',

  story: {
    logline: 'A conversation with one teammate whose mind stays warm between your turns.',
    opening: (
      <>
        <p>
          A <strong>chat</strong> is you and one teammate, talking. You write a turn, the teammate answers, and the
          transcript is the entity. Its panel is the conversation itself, not a tab hanging off something else.
        </p>
        <p>
          Before chats, getting an agent to think with you meant launching a work session: a terminal, a lane, a
          process you watched scroll past. That is the right tool for work. A chat is for everything around the work,
          like asking why, trying an idea, or planning before anything is dispatched. It has no terminal at all. Behind
          it is a headless agent process that keeps its context from one turn to the next.
        </p>
      </>
    ),
    beats: [
      {
        eyebrow: 'Why it feels fast',
        title: 'One process, kept warm',
        body: (
          <p>
            A chat keeps a single headless Claude Code process alive between turns. Its input stays open, so the model
            keeps its context and its prompt cache instead of re-reading the thread every time. Turns are taken from a
            durable queue, one at a time. If the node restarts or a turn is interrupted, the chat is marked{' '}
            <em>stopped</em>. The next turn resumes the same native conversation by id, so nothing starts over.
          </p>
        ),
      },
      {
        eyebrow: 'The signature',
        title: 'Two clocks, not one',
        body: (
          <>
            <p>
              A chat reports two separate facts. The <strong>runtime</strong> is whether a process exists (cold, live
              or stopped). The <strong>turn</strong> is what the conversation is doing (idle, queued or running). They
              move independently. A stopped chat with a queued turn means the node restarted and your message is still
              coming. <code>tm8 chat list</code> prints both for exactly that reason.
            </p>
            <TwoClocks />
          </>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Chosen once, kept for life',
        body: (
          <p>
            <code>tm8 chat start</code> requires a teammate, a model, a mode and a workdir, and it has no default for
            any of them. That is deliberate: the teammate, the model and the working directory are fixed for the
            chat&rsquo;s whole life, and an invented default would be a chat nobody chose. The mode is the one
            exception. It is the chat&rsquo;s default posture (ask, explain, plan, build, orchestrate or craft), and a
            single turn can carry a different one. Modes change what the teammate is told, not what its tools can
            reach. Chats run claude-code models only.
          </p>
        ),
      },
      {
        eyebrow: 'Where it works',
        title: 'The project as it stands, or a room of its own',
        body: (
          <p>
            A <em>project</em> workdir is the Space&rsquo;s project folder exactly as it is, uncommitted changes
            included. There is no clone and no branch, so the chat sees what you see. A <em>scratch</em> workdir is an
            empty directory the server makes for this chat alone. A chat never gets a worktree lane. That is what a
            work session is for, and a chat in build or orchestrate mode can start one. Any worker it starts takes the
            chat as its parent and reports back to it.
          </p>
        ),
      },
      {
        eyebrow: 'Who can speak',
        title: 'Anyone can reach it, and it never hears itself',
        body: (
          <p>
            A chat anchors its own transcript, so anyone who can post a message can reach it: you, a work session, or
            another chat. <code>tm8 chat send</code> and <code>tm8 message send --to</code> are the same call. Every
            message lands as a turn, except the ones this chat wrote itself. That guard is keyed on where a message
            came from, not who wrote it, so the same teammate writing from somewhere else still gets through.
          </p>
        ),
      },
    ],
    lifecycle: [
      { name: 'Started', note: 'chat start writes the chat and its first message in one transaction. No process yet; the runtime is cold.' },
      { name: 'Live', note: 'The first turn launches the process. Every later turn reuses it, one at a time from the queue.' },
      { name: 'Stopped', note: 'An interrupted turn, an error or a node restart ends the process. The transcript is untouched.' },
      { name: 'Resumed', note: 'The next turn relaunches against the same native conversation id. The chat is live again, context intact.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        From a terminal, a chat is mostly an address. People open chats, and a browser or a human credential starts
        them. Agents and sessions talk to chats by posting to them, and they read how a chat is doing from its two
        clocks. There is no <code>chat stop</code>, <code>chat mode</code> or <code>chat model</code>, because
        what was pinned stays pinned.
      </p>
    ),
    scenes: [
      {
        title: 'Open one',
        narrative: (
          <p>
            <code>tm8 chat start</code> needs a human credential, the same way the browser composer is the human door.
            It writes the chat and its opening message together, so there is no empty chat waiting for a first post.
            Pass <code>--about</code> to record what the chat concerns, such as a task, a pull request or a blueprint.
            The teammate is shown that on every turn.
          </p>
        ),
        commands: ['chat start'],
        demo: [
          '# every flag below is required, and each is fixed for the chat’s life',
          'tm8 chat start --teammate <team-member-id> --model <model> --mode ask --workdir project --project <project-id> --about <task-id> "Why does the arm64 build fail?"',
        ],
      },
      {
        title: 'Talk to it',
        narrative: (
          <p>
            A turn is a message on the chat&rsquo;s anchor, so any caller that can post a message can reach it. When a
            work session posts, its session id is forwarded, which records where the message was authored and stops
            a chat from answering its own words. Add <code>--wait settled</code> to block until delivery settles.
            Exit 11 means the message was stored but not yet settled. It never means the message was lost.
          </p>
        ),
        commands: ['chat send', 'message send'],
        demo: [
          'tm8 chat send <chat-id> "Now try the same on the release branch"',
          '# from inside a work session, the identical call',
          'tm8 message send --to <chat-id> "CI is green on arm64"',
        ],
      },
      {
        title: 'Read the two clocks',
        narrative: (
          <p>
            <code>tm8 chat list</code> shows each chat&rsquo;s runtime and turn state side by side.{' '}
            <code>tm8 chat show</code> is the bounded view: configuration, a recent excerpt and what the chat is about.{' '}
            <code>tm8 chat turns</code> pages the transcript. Given <code>--message</code>, it shows the one turn that
            message queued, with its own queued, running, completed or error state.
          </p>
        ),
        commands: ['chat list', 'chat show', 'chat turns'],
        demo: ['tm8 chat list --limit 20', 'tm8 chat turns <chat-id> --limit 10', '# which turn did my message start, and how is it going?', 'tm8 chat turns --message <message-id>'],
      },
      {
        title: 'Space defaults',
        narrative: (
          <p>
            When someone opens a chat about an entity, the Space can suggest the teammate and model for that
            entity&rsquo;s kind. These are starting points for the composer, not pins. Once a chat starts, its own
            choices are the ones that last.
          </p>
        ),
        commands: ['space chat-defaults get', 'space chat-defaults set'],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A chat has few named edges, and each one does a job. <strong>About</strong> points at what the chat
        concerns. <strong>Made here</strong> stamps everything the chat&rsquo;s agent writes with the chat as its
        source. Everything else is the general-purpose wiring every entity shares. Look for the about edge first,
        because it is what the teammate is told the conversation is for.
      </p>
    ),
    notes: {
      'about:outgoing':
        'What the chat was opened about. It is read fresh from the live edge on every turn and handed to the teammate, so correcting it changes what the next turn is told.',
      'authored_from:incoming':
        'Every message this chat’s agent posts is stamped with the chat as its source. The stamp comes from the agent’s own credential, never from the request, so it cannot be claimed falsely.',
      'about:incoming': 'Another chat or a memory that is about this chat.',
      'authored_from:outgoing': 'The work session the chat was made during, recorded by the server.',
    },
    spotlight: ['message', 'artifact', 'memory', 'form'],
  },
};
