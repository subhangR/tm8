import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getKind } from '../domain';
import {
  buildSpawnInput,
  canLaunch,
  defaultLaunchTarget,
  type LaunchConfig,
  type WorkdirMode,
} from '../domain/launch';
import { createdIdOf, newEntityInput } from '../authoring';
import { LiveTerminal, TerminalHost } from '../terminal';
import type { CommandResult, CreateEntityInput, EntityId, ExecutionSpawnInput, SpaceId } from '@tm8/contract';
import type { TriggerOption } from '../rich-input';
import type { FileUploadTask } from '../files/upload';
import { NewSessionComposer } from './NewSessionComposer';
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
  /** The launch resources the spawn needs; `data.launch`. */
  launch: {
    teammates: readonly { id: string; name: string; model: string; agentTool: string }[];
    projects: readonly { id: string; name: string; trusted: boolean; untrustedReason?: string }[];
    capacity?: { slotsFree: number; slotsTotal: number };
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
  const [workdirMode, setWorkdirMode] = useState<WorkdirMode>('worktree');
  const inFlight = useRef(false);

  const teammate = launch.teammates[0] ?? null;
  const project = launch.projects.find((candidate) => candidate.trusted) ?? null;

  /*
   * The config the spawn will use. Rendered under the composer at all times —
   * that visibility is what buys the single keystroke, per the ruling on
   * `LaunchQuickConfig`'s "two clicks to launch, never one".
   *
   * `fullAccess` is the OWNER'S RULING, made against a recommendation of
   * `acceptEdits`, and is recorded as a deliberate choice rather than a
   * default nobody examined.
   */
  const config: LaunchConfig = useMemo(() => ({
    teamMemberId: (teammate?.id ?? null) as EntityId | null,
    agentToolId: teammate?.agentTool ?? null,
    model: teammate?.model ?? null,
    reasoningEffort: null,
    accessMode: 'fullAccess',
    mode: 'worker',
    target: defaultLaunchTarget(project?.id as never),
    workdirMode,
  }), [teammate, project, workdirMode]);

  /* A scratch target has no checkout to branch from, so the workdir choice is
     not a choice there — offered as disabled rather than silently ignored. */
  const workdirChoosable = config.target.kind === 'project';

  const refusal = useMemo(() => {
    if (commands === null) return 'This node cannot create tasks, so a session cannot be started here.';
    const verdict = canLaunch(config, { projects: launch.projects as never, capacity: launch.capacity });
    if (!verdict.ok) return verdict.reason;
    if (!canDeriveTitle(draft)) return null; // Empty is not an error, it is just not ready.
    return null;
  }, [commands, config, launch.projects, launch.capacity, draft]);

  const title = deriveTitle(draft);
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
          draft={draft}
          onDraftChange={setDraft}
          onSubmit={() => { void start(); }}
          busy={transitioning}
          refusal={error ?? refusal}
          derivedTitle={title}
          teammateLabel={teammate?.name ?? 'no teammate'}
          modelLabel={teammate?.model ?? 'no model'}
          accessModeLabel={config.accessMode ?? 'default access'}
          workdirMode={workdirMode}
          onWorkdirModeChange={setWorkdirMode}
          workdirChoosable={workdirChoosable}
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
               the box the user sees never changes shape. */
            <TerminalHost placeholder={'▉ preparing the session\nno PTY yet'} />
          )}
        </div>
      ) : null}

      {transitioning ? (
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
      ) : null}
    </div>
  );
}
