import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getKind } from '../domain';
import {
  buildSpawnInput,
  canLaunch,
  type LaunchCapacity,
  type LaunchProject,
  type LaunchTeammate,
} from '../domain/launch';
import { createdIdOf, newEntityInput } from '../authoring';
import { AlwaysDark, LiveTerminal, TerminalHost } from '../terminal';
import type {
  CommandResult, CreateEntityInput, EntityId, ExecutionSpawnInput, SpaceId,
} from '@tm8/contract';
import type { TriggerOption } from '../rich-input';
import type { FileUploadTask } from '../files/upload';
import { NewSessionComposer } from './NewSessionComposer';
import { useLaunchComposerState } from './useLaunchComposerState';
import { canDeriveTitle, deriveTitle, promptBody } from './prompt-title';
import './new-session.css';

/**
 * NEW SESSION — one prompt, one keystroke, one running agent.
 *
 * THE SEQUENCE, and the ORDER IS LOAD-BEARING:
 *
 *   1. mint the task   — `entities.create`, title derived from the first
 *                        sentence, the whole prompt as `content.description`.
 *                        ONE call: the server maps `content.description` for a
 *                        task (server/facade/handlers/entities.ts:578), so no
 *                        follow-up patch is needed.
 *   2. MOUNT THE HOST  — a real, full-size, visible `.term-host` goes into the
 *                        DOM *before* the spawn, not after.
 *   3. spawn           — `execution.spawn` with `taskIds: [the new task]`.
 *   4. attach          — the session's own `LiveTerminal` replaces the host.
 *
 * WHY STEP 2 COMES BEFORE STEP 3. `measureSpawnTerminalSize` prefers a module
 * global and otherwise reads the FIRST `.term-host` in the document; with no
 * terminal mounted it returns `{}` and the geometry is simply unknown. On this
 * branch that costs only a wrong first local fit, because `execution.spawn`
 * carries no cols/rows yet. It stops being cheap the moment it does: the PTY
 * would then boot at whatever that measurement said, and an agent lays out its
 * entire TUI for the width it is born with. Mounting first makes the
 * measurement describe a box that genuinely exists at the size the user is
 * about to see, and costs nothing today.
 *
 * WHY THE PROMPT RIDES THE TASK BODY. It reaches the agent as its FIRST TURN,
 * rendered as a task assignment with `transport="spawn_initial_turn"`
 * (prompt/src/templates.ts:268-289) — immediate, and read as instructions. The
 * two alternatives are traps: a post-spawn message is TYPED INTO THE RUNNING
 * AGENT'S TUI and can take ~60s to land, and `promptExtra` arrives wrapped as
 * `<untrusted_data type="launch-context">`, which the agent is told to treat
 * as material to act ON, not instructions to act BY.
 *
 * EVERY BEAT IS A REAL MILESTONE. The phase advances when the node answers,
 * never on a timer, so a slow spawn stretches the animation instead of
 * completing into an empty terminal. A transition that finishes early is worse
 * than none: it claims something that has not happened.
 */

/** The staged beats, in order. `live` is the terminal owning the screen. */
export type NewSessionPhase = 'idle' | 'minting' | 'spawning' | 'attaching' | 'live';

const STEPS: readonly { phase: NewSessionPhase; label: string }[] = [
  { phase: 'minting', label: 'creating the task' },
  { phase: 'spawning', label: 'starting the session' },
  { phase: 'attaching', label: 'attaching the terminal' },
];

const ORDER: readonly NewSessionPhase[] = ['idle', 'minting', 'spawning', 'attaching', 'live'];

/** How long a spawn may run before the veil admits it is slow, rather than pulsing forever. */
const SLOW_AFTER_MS = 9000;

export interface NewSessionScreenProps {
  spaceId: SpaceId;
  /** `data.seam.commands` — absent means this node cannot create, and Send says so. */
  commands: {
    createEntity: (input: CreateEntityInput) => Promise<CommandResult>;
  } | null;
  /** `data.spawn` — resolves to the new session's entity id. */
  spawn: (input: ExecutionSpawnInput) => Promise<EntityId>;
  /**
   * The launch resources the spawn needs — `data.launch`, in ITS OWN TYPES.
   *
   * Spelled with the real `LaunchTeammate`/`LaunchProject` rather than a
   * hand-written structural echo, because the echo is how the two project
   * shapes got confused: `LaunchProject` carries `id`, while `canLaunch` wants
   * `LaunchProjectOption` with `projectId`. A local shape plus a cast compiled
   * happily and would have refused every project-backed launch at runtime with
   * "that project is not linked to this space". `projectOptionsOf` below does
   * the conversion once, in the open.
   */
  launch: {
    teammates: readonly LaunchTeammate[];
    projects: readonly LaunchProject[];
    capacity?: LaunchCapacity;
  };
  /** Where the session opens once it is live. */
  onSessionReady: (sessionId: EntityId) => void;
  serverBaseUrl?: string;
  skillOptions?: readonly TriggerOption[];
  attach?: (file: File) => FileUploadTask;
}

export function NewSessionScreen({
  spaceId,
  commands,
  spawn,
  launch,
  onSessionReady,
  serverBaseUrl,
  skillOptions,
  attach,
}: NewSessionScreenProps) {
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<NewSessionPhase>('idle');
  const [sessionId, setSessionId] = useState<EntityId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const inFlight = useRef(false);

  const [customTitle, setCustomTitle] = useState('');

  /*
   * THE COMPOSER'S CONFIG lives in `useLaunchComposerState`, shared verbatim
   * with the Run popup (`LaunchComposerPopup`) so the two hosts of this card
   * cannot drift into different spawn semantics. Seeds and their reasons are
   * documented there; the one worth restating here: `accessMode: 'auto'`
   * SUPERSEDES the earlier invisible-`fullAccess` ruling, because the posture
   * is now a visible one-click control on the card — the viewer sees and owns
   * the escalation instead of inheriting it.
   */
  const { config, projectOptions, bind } = useLaunchComposerState({
    teammates: launch.teammates,
    projects: launch.projects,
  });

  const refusal = useMemo(() => {
    if (commands === null) return 'This node cannot create tasks, so a session cannot be started here.';
    const verdict = canLaunch(config, { projects: projectOptions, capacity: launch.capacity });
    if (!verdict.ok) return verdict.reason;
    if (!canDeriveTitle(draft)) return null; // Empty is not an error, it is just not ready.
    return null;
  }, [commands, config, projectOptions, launch.capacity, draft]);

  /* The typed title wins; the derived one fills in. Both are visible in the
     title field at all times (value vs placeholder), so the name a launch
     commits is never a surprise. */
  const derived = deriveTitle(draft);
  const title = customTitle.trim() !== '' ? customTitle.trim() : derived;
  const ready = canDeriveTitle(draft) && refusal === null && commands !== null;

  /* The slow notice is time-based BECAUSE it is a statement about elapsed
     time — it never advances the phase, it only admits the wait. */
  useEffect(() => {
    if (phase !== 'spawning' && phase !== 'attaching') { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const start = useCallback(async () => {
    if (inFlight.current || !ready || commands === null) return;
    inFlight.current = true;
    setError(null);
    setPhase('minting');

    let taskId: EntityId | null = null;
    try {
      /* PRE-FLIGHT ALREADY DONE: `canLaunch` gates `ready`, so a refusal
         cannot leave an orphan task behind — the task is only minted once the
         spawn is known to be permissible. */
      const taskKind = getKind('task');
      const created = await commands.createEntity(
        newEntityInput(spaceId, taskKind.kind as never, title, null, {
          description: promptBody(draft),
        }),
      );
      taskId = createdIdOf(created) as EntityId | null;
      if (taskId === null) {
        /* Created, but we do not know WHAT. Distinct from a failure: something
           exists on the node. Say so rather than inventing either outcome. */
        throw new Error('The task was created but the node did not return its id.');
      }

      /* STEP 2 — the host is mounted by this render, before the spawn below.
         See the docblock: the paint must happen first. */
      setPhase('spawning');
      await new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); });

      const id = await spawn(buildSpawnInput({
        clientMutationId: `ns-${taskId}`,
        spaceId,
        config,
        taskIds: [taskId],
        title,
      }));

      setSessionId(id as EntityId);
      setPhase('attaching');
    } catch (cause) {
      /* THE TASK SURVIVES A FAILED SPAWN. It holds the user's prompt verbatim,
         and deleting it to keep the list tidy would discard the only copy of
         what they typed. Say what exists and let them retry. */
      setPhase('idle');
      const detail = String((cause as { message?: string })?.message ?? cause);
      setError(taskId
        ? `${detail} — the task was created and still holds your prompt; press Enter to try the session again.`
        : detail);
    } finally {
      inFlight.current = false;
    }
  }, [ready, commands, spaceId, title, draft, config, spawn]);

  /* The hand-off. Deliberately NOT inside the spawn promise: the screen owns
     its own transition to `live`, and the host decides when the URL follows. */
  const settle = useCallback(() => {
    if (!sessionId) return;
    setPhase('live');
    onSessionReady(sessionId);
  }, [sessionId, onSessionReady]);

  const stepState = (step: NewSessionPhase): 'pending' | 'active' | 'done' =>
    ORDER.indexOf(phase) > ORDER.indexOf(step) ? 'done'
      : phase === step ? 'active'
        : 'pending';

  const transitioning = phase === 'minting' || phase === 'spawning' || phase === 'attaching';

  return (
    <div className="nsx-root" data-phase={phase} data-testid="new-session-root">
      <div className="nsx-stage">
        <div className="nsx-greeting">
          New session
          <p className="nsx-greeting__sub">
            Describe what you want done. Enter creates the task and starts an agent on it.
          </p>
        </div>
        <NewSessionComposer
          {...bind}
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={() => { void start(); }}
          busy={transitioning}
          refusal={error ?? refusal}
          derivedTitle={derived}
          title={customTitle}
          onTitleChange={setCustomTitle}
          skillOptions={skillOptions}
          attach={attach}
          autoFocus
        />
      </div>

      {/*
        THE TERMINAL LAYER. Mounted from the first transitional frame and never
        hidden — `.nsx-terminal-layer` animates opacity and transform only.
        Anything that gave this subtree a zero-size rect or `visibility:hidden`
        would hit a `sendResize` branch that does NOT reschedule, and the money
        shot would be a blank terminal.
      */}
      {(transitioning || phase === 'live') ? (
        <div className="nsx-terminal-layer">
          {sessionId ? (
            <LiveTerminal
              sessionId={sessionId}
              serverBaseUrl={serverBaseUrl}
              live
              autoFocus={phase === 'live'}
              /* The FIRST successful fit is the terminal telling us it has
                 real geometry and has painted. That — not a timer — is what
                 ends the transition. */
              onResize={settle}
            />
          ) : (
            /* The pre-spawn host: a real, measurable `.term-host` at final
               size. Same component the session panel uses for `spawning`, so
               the box the user sees never changes shape.
               DELIBERATELY NO PLACEHOLDER TEXT: the veil's steps are centred
               over this box and say the same thing better. Photographed with
               one, the host's centred hint rendered THROUGH the step list and
               both became unreadable. The box is here for its geometry, not
               its words. */
            <TerminalHost />
          )}
        </div>
      ) : null}

      {transitioning ? (
        /* ALWAYS-DARK, because the veil sits ON the terminal: the scope
           re-declares the dark ramp so `--pn-paper`/`--pn-ink` resolve to
           light-on-dark in BOTH themes, with no literal colour anywhere. */
        <AlwaysDark>
        <div className="nsx-veil" data-testid="nsx-veil">
          <p className="nsx-veil__title">{title}</p>
          <ul className="nsx-steps">
            {STEPS.map((step) => (
              <li key={step.phase} className="nsx-step" data-state={stepState(step.phase)}>
                <span className="nsx-step__mark" aria-hidden="true">
                  {stepState(step.phase) === 'done' ? '✓' : '▍'}
                </span>
                {step.label}
              </li>
            ))}
          </ul>
          {slow ? (
            <p className="nsx-veil__slow" role="status">
              Still starting — the node has not reported the session live yet.
            </p>
          ) : null}
        </div>
        </AlwaysDark>
      ) : null}
    </div>
  );
}
