/**
 * THE ACTION REGISTRY (LLD §2.5) — the single place a verb exists.
 *
 * The same `ActionDef` serves the list tile's quick-action, the panel action
 * bar, ⌘Enter, and the palette row. No verb is wired twice, and no surface
 * invents its own availability rule.
 *
 * Availability composes, in the LLD §10.3 precedence order:
 *   1. known-at-design-time gates (R7 deferrals, §10.7 seam amendments) —
 *      authored reason copy, no probe;
 *   2. facade `CollabError` verdicts the shell has already cached
 *      (`ctx.opUnavailable`, one probe per op);
 *   3. server capability truth (`EntityDetail.capabilities`).
 *
 * L6 everywhere: an unavailable action is DISABLED WITH A REASON, never hidden
 * and never silently inert.
 */
import type {
  ActionAvailability,
  ActionContext,
  ActionDef,
  ActionRef,
  IconRef,
} from './types';
import type { LaunchMode } from './launch';

const AVAILABLE: ActionAvailability = { kind: 'available' };

const disabled = (reason: string): ActionAvailability => ({ kind: 'disabled', reason });

/**
 * D15 — the authored disabled-with-reason copy. One place, so the honesty
 * vocabulary cannot drift across surfaces. Each string names the MECHANISM,
 * not just the refusal (T1-4 honesty vocabulary).
 */
export const REASONS = {
  noEntity: 'Nothing is selected.',
  unknownCapabilities: 'Waiting for this entity to load — its permissions are not known yet.',
  cannotEdit: 'You do not have permission to edit this entity.',
  cannotArchive: 'You do not have permission to archive this entity.',
  // D67. `entities.restore` shares `canDelete` — the facade publishes ONE
  // tombstone capability, and inventing a `canRestore` here would be this
  // package asserting a permission the server never answered for.
  cannotRestore: 'You do not have permission to restore this entity.',
  cannotComplete: 'This entity cannot be completed.',
  cannotPull: 'This entity cannot be pulled.',
  cannotLink: 'You do not have permission to link this entity.',
  cannotAddChild: 'You do not have permission to add children here.',
  cannotReact: 'Reactions are not available on this entity.',
  cannotGrantPoints: 'You do not have permission to grant points here.',
  notLive: 'This session is not live — there is nothing running to act on.',
  alreadyEnded: 'This session has already ended — it is under Done.',
  /* Resume's refusal, and the exact complement of the line above. It is
     reached only where the tail slot is drawn without the swap (the palette,
     a surface that names the verb directly); on a row the swap means this
     state shows Terminate instead, so the two are never both refused. */
  notEnded: 'This session hasn’t ended — there is nothing to resume.',
  livenessUnknown: 'Liveness is unverified on this node right now — the session cannot be acted on until it is confirmed.',
  // §10.7 deferred seam amendments (dual re-consensus pending)
  handoffSendDeferred:
    'Sharing into a session is not wired yet: handoffs.send is not in the stamped facade seam. The affordance is real; the operation is not available.',
  handoffWithdrawDeferred:
    'Withdrawing a handoff is deferred: handoffs.withdraw is not in the stamped facade seam, and withdrawal is not reversible once it is.',
  // R7 deferred features (never hidden, never built)
  //
  // `graphDeferred` RETIRED 2026-08-15. It read "Graph view isn't available
  // yet." while `{ view: 'graph' }` was an addressable route, a live rail
  // group and a live palette destination — so the palette rendered a disabled
  // discovery row for a screen the row above it would happily open. The
  // route-side half of this went with #220; this is its other half. The copy
  // goes rather than being rewritten, because there is no longer anything for
  // it to be honest ABOUT: a deferral notice must not outlive the deferral.
  undoDeferred: 'Undo isn’t available yet — actions in this build are not reversible.',
  versionHistoryDeferred: 'Version history isn’t available yet.',
  leaderboardDeferred: 'The leaderboard isn’t available yet.',
  awardsDeferred: 'Awards aren’t available yet.',
  savedViewsDeferred: 'Saved views and axis management aren’t available yet.',
  searchResultsDeferred: 'A full search results view isn’t available yet — the palette is the search surface.',
  activityScreenDeferred: 'The activity screen isn’t available yet.',
  addServerDeferred: 'Remote servers arrive in Phase 2 — this node is the only one wired.',
  /*
   * CONTAINER LIFECYCLE (Design §13.1's `capabilityReasons`, stated once).
   *
   * `registry.ts` imports `CONTAINER_CAPABILITY_REASONS` below and uses these
   * SAME strings for `panel.capabilityReasons`, so the sentence a verb refuses
   * with and the sentence the body prints cannot drift into two wordings of
   * one rule.
   */
  containerCapabilitiesUnknown:
    'Waiting for this container to load — the node has not said what may be done to it yet.',
  containerScreenDeferred:
    'The screen surface isn’t built yet. The container is real and running; what is missing is the viewer, so this verb is refused rather than hidden.',
  // T0-4 kind primaries (Surface Audit): drawn, ledgered, not yet executable.
  equipDeferred: 'Equipping isn’t wired yet — the verb exists; its executor does not.',
  refreshDeferred: 'Refreshing from the source isn’t wired yet.',
  untrustDeferred: 'Trust changes aren’t wired yet — trust is a governed edit.',
  unlinkDeferred: 'Unlinking isn’t wired yet.',
  setAsDefaultDeferred: 'Setting a default isn’t wired yet.',
  markReadDeferred: 'Read-state isn’t wired yet.',
  quoteDeferred: 'Quoting into the composer isn’t wired yet.',
} as const;

/** Op-name gate (precedence 2): a facade refusal the shell already cached. */
function opGate(ctx: ActionContext, op: string): ActionAvailability | null {
  const reason = ctx.opUnavailable?.[op];
  return reason ? disabled(reason) : null;
}

/** Capability gate (precedence 3): SERVER truth decides; absent ⇒ not permitted. */
function capabilityGate(
  ctx: ActionContext,
  flag: 'canEdit' | 'canDelete' | 'canAddChild' | 'canLink' | 'canPull' | 'canReact' | 'canGrantPoints' | 'canComplete',
  reason: string,
): ActionAvailability | null {
  if (!ctx.entityId) return disabled(REASONS.noEntity);
  if (ctx.capabilities == null) return disabled(REASONS.unknownCapabilities);
  return ctx.capabilities[flag] ? null : disabled(reason);
}

/**
 * THE CONTAINER CAPABILITY SENTENCES — one copy, two consumers.
 *
 * Exported because `domain/registry.ts` seats them in the container row's
 * `panel.capabilityReasons`. Two hand-kept copies of a refusal is how one
 * surface ends up explaining a rule the other contradicts.
 */
export const CONTAINER_CAPABILITY_REASONS = {
  canStart: 'only a stopped container can start',
  canStop: 'only a running or paused container can be stopped',
  canDestroy: 'this container is already being destroyed',
  canAttach: 'the screen is live only while the container runs',
  canExec: 'a terminal needs a running container',
} as const;

/**
 * THE CONTAINER CAPABILITY GATE — and it exists because these six booleans are
 * OPTIONAL, which `capabilityGate` above cannot express.
 *
 * `EntityCapabilities` is a FLAT interface: eight required booleans that every
 * kind carries, plus `allowedTransitions?` and — since migration 177 — six
 * optional container ones. They had to be optional; making them required would
 * have stopped every literal in this repo that constructs an
 * `EntityCapabilities` from compiling, `isAlwaysDisabled` below included.
 *
 * THREE STATES, AND THE THIRD IS THE ONE THAT MATTERS:
 *
 *   true       → the node permits it.
 *   false      → the node refuses it; say WHICH rule, from the table above.
 *   undefined  → NOT PERMITTED. Never `true`.
 *
 * DO NOT REACH FOR `allowedTransitions?` AS THE PRECEDENT FOR THE THIRD LINE.
 * It is the same shape in the same interface with the OPPOSITE default: absent
 * there means "no matrix — fall back to the registry vocabulary", i.e. MORE
 * permissive, because it NARROWS a permission that already exists. These GRANT
 * one that otherwise does not. A reader who carries the semantics across with
 * the shape turns every unanswered capability into a live button.
 *
 * So this must not be "simplified" to `ctx.capabilities?.[flag] ?? true`, and
 * the `undefined` arm must not be deleted as dead code because the server we
 * have today always populates it: absence is legal in the contract, and an
 * older node is a legal peer.
 */
function containerCapabilityGate(
  ctx: ActionContext,
  flag: 'canStart' | 'canStop' | 'canDestroy' | 'canAttach' | 'canControl' | 'canExec',
  reason: string,
): ActionAvailability | null {
  if (!ctx.entityId) return disabled(REASONS.noEntity);
  if (ctx.capabilities == null) return disabled(REASONS.unknownCapabilities);
  /* Through `unknown`: `EntityCapabilities` has no index signature, and a
     direct cast is refused. Reading by a typed key would lose the third state
     — `undefined` — which is the whole point of this gate. */
  const permitted = (ctx.capabilities as unknown as Record<string, unknown>)[flag];
  if (permitted === true) return null;
  // ABSENT is not REFUSED, and the two get different words: a container whose
  // node has not answered is not the same as one whose status forbids the
  // verb, and telling a viewer "only a stopped container can start" about a
  // container we have no capability read for would be inventing a cause.
  if (permitted === undefined) return disabled(REASONS.containerCapabilitiesUnknown);
  return disabled(reason);
}

/**
 * A verb that retires a row: permitted until the row has already reached its
 * end. USER RULING 2026-08-19 — "if session is alive, or in progress or to do
 * the terminate button should always be available, hitting that should
 * terminate it and move it to done. this removes the cases where some sessions
 * are terminated, but have no terminate button enabled".
 *
 * THE OLD GATE WAS THE WRONG QUESTION. `terminate` was `livenessGate`d, which
 * permits it only on a `live` seam verdict — so a session that is `stale` or
 * `unknown` drew a dead Terminate button. Those are precisely the rows that
 * need retiring: a ghost left `running` by a node restart is not live, is not
 * finished, and sat in To Do or In Progress with no way to move it.
 *
 * The server was never the obstacle. `SpawnService.terminate` already treats a
 * missing PTY as success — "'not_found' is not an error: terminating an
 * already-dead session is the user cancelling something that just finished" —
 * and writes `status: 'exited'` regardless, which since migration 155 files the
 * row under Done. The client was refusing an operation the node performs.
 *
 * `done` is the one refusal left, and it is a statement rather than a
 * capability guess: a row that already ended cannot be ended again. Absent
 * category ⇒ PERMITTED, not refused — the same posture `capabilityGate` takes
 * for a missing flag inverted, because here the failure mode of guessing wrong
 * is a harmless second terminate rather than a stuck row.
 *
 * BUT `done` ALONE IS NOT "ENDED" ANY MORE, and that is this same PR's doing.
 * The tick files a RUNNING session under Done without closing it — that is the
 * whole ruling — so `category === 'done'` and "a process is answering" are now
 * compatible states, and the first no longer implies the second. Gating on the
 * category alone made the headline feature eat itself: tick a live session and
 * Terminate went dead on every surface (the row cluster and the panel's
 * primary both resolve THIS def), refusing with "This session has already
 * ended" about a session that was still streaming. Measured before this line
 * existed: `{liveness:'live', category:'done'}` -> disabled.
 *
 * So the refusal asks for BOTH halves — filed under Done AND nothing is
 * answering. That keeps every case the ruling above cares about:
 *
 *   ghost (stale/unknown, not done)   PERMITTED — the reported defect.
 *   exited or failed (done, no PTY)   REFUSED — it genuinely ended.
 *   ticked while running (done, live) PERMITTED — it has NOT ended, and the
 *                                     tick was never a claim that it had.
 *
 * A non-`live` verdict on a ticked session still refuses, which is the
 * conservative side of the one genuinely ambiguous case and matches how an
 * exited row reads. `liveness` is consulted here and NOT in the ruling above
 * because it is being asked a different question: not "may I act on this" but
 * "is the thing I would be ending still there".
 */
function endableGate(ctx: ActionContext): ActionAvailability | null {
  if (!ctx.entityId) return disabled(REASONS.noEntity);
  if (hasEnded(ctx)) return disabled(REASONS.alreadyEnded);
  return null;
}

/**
 * HAS THIS ROW'S RUN ENDED — the ONE predicate the tail slot turns on.
 *
 * Terminate and Resume are a single control sharing one slot: a row shows
 * ⏻ Terminate while something could still be answering, and ↺ Resume once
 * nothing is. That swap is only TOTAL and UNAMBIGUOUS — never two buttons,
 * never zero — while both halves ask the identical question, so the question
 * has exactly one definition and lives here. Inline either copy of it and the
 * two drift the first time the rule is amended, which is the state this
 * function was extracted out of: `endableGate` had it written into its body,
 * and a complement written by hand beside it would be a second copy.
 *
 * The row cluster consults it a third time, to drop the tick on an ended run
 * (`EntityControls.RowActionCluster`), so this is also what keeps the count of
 * controls in that state at one rather than two-with-one-greyed.
 *
 * WHY BOTH HALVES AND NOT JUST THE CATEGORY: since the tick shipped, `done`
 * and "a process is answering" are compatible — ticking a running session
 * files it under Done without closing it — so the category alone no longer
 * implies the run is over. See `endableGate` above for the measured failure.
 *
 * KNOWN, ACCEPTED IMPRECISION. `ActionContext` carries no session STATUS
 * (see its docblock in `types.ts`), and the server's real guard on resume is
 * `status IN ('exited','failed')`. So a session ticked while `spawning` that
 * never ran reads as ended here and is offered a Resume the node will refuse
 * with `only exited or failed sessions can be resumed`. That is the right
 * trade: a refused resume is NON-DESTRUCTIVE and the node's message is
 * honest, whereas adding a status field to this context to pre-empt it would
 * make this layer COMPUTE a verdict it is supposed to present (R-UI-5).
 */
export function hasEnded(ctx: Pick<ActionContext, 'category' | 'liveness'>): boolean {
  return ctx.category === 'done' && ctx.liveness !== 'live';
}

/** The literal complement of `endableGate`'s refusal — see `hasEnded`. */
function resumableGate(ctx: ActionContext): ActionAvailability | null {
  if (!ctx.entityId) return disabled(REASONS.noEntity);
  if (!hasEnded(ctx)) return disabled(REASONS.notEnded);
  return null;
}

/**
 * THE TWO HALVES OF THE PROCESS CONTROL, named once.
 *
 * Both the row cluster and the panel action bar resolve one declared slot to
 * one of these per row. Naming the pair here rather than writing
 * `ref === 'terminate' ? 'resume' : ref` at each site keeps the action-id
 * literals out of the components (§15.2) and — the part with teeth — lets the
 * mount-site guard DERIVE which verbs a surface can reach. `resume` is
 * declared by no registry row (see work_session's `rowActions`), so a guard
 * that only reads the registry would call the dispatcher's resume dead code.
 */
export const PROCESS_CONTROL = {
  /** While something could still be answering. */
  running: 'terminate',
  /** Once the run has ended. */
  ended: 'resume',
} as const satisfies { running: ActionRef; ended: ActionRef };

/**
 * Resolve the process control's slot for one row. Any other verb passes
 * through untouched, so a surface can map its whole declared list through it
 * without asking which entry is the process control.
 */
export function processControlFor(
  ref: ActionRef,
  ctx: Pick<ActionContext, 'category' | 'liveness'>,
): ActionRef {
  return ref === PROCESS_CONTROL.running && hasEnded(ctx) ? PROCESS_CONTROL.ended : ref;
}

/** A verdict-gated session verb: only a `live` seam verdict permits it. */
function livenessGate(ctx: ActionContext): ActionAvailability | null {
  if (!ctx.entityId) return disabled(REASONS.noEntity);
  switch (ctx.liveness) {
    case 'live':
      return null;
    case 'unknown':
    case undefined:
      return disabled(REASONS.livenessUnknown);
    default:
      return disabled(REASONS.notLive);
  }
}

function define(
  id: ActionRef,
  label: string,
  icon: IconRef,
  availability: (ctx: ActionContext) => ActionAvailability,
  run?: (ctx: ActionContext) => Promise<void> | void,
): ActionDef {
  return {
    id,
    label,
    icon,
    availability,
    run:
      run ??
      ((ctx) => {
        // The default runner is a pure dispatch: `domain/` never imports the
        // seam, so the shell's injected dispatcher performs the write.
        if (availability(ctx).kind !== 'available') return;
        if (!ctx.dispatch) {
          // FINDING #9 (enabled-inert) MADE STRUCTURAL. This used to be
          // `ctx.dispatch?.(…)` — an optional call, so an action the UI had
          // rendered ENABLED did nothing at all when no dispatcher was wired.
          // The user clicks, nothing happens, and no signal reaches anyone:
          // exactly the F6/X4 class this package renders disabled-with-reason
          // to avoid. An affordance that is enabled and inert is a worse lie
          // than one that is disabled with a reason, because the disabled one
          // at least tells the truth about what it can do.
          //
          // A missing dispatcher is a WIRING DEFECT, not a runtime condition —
          // it cannot be fixed by the user and must not be absorbed silently.
          throw new Error(
            `Action "${id}" is available but no dispatcher is wired: the surface rendered it enabled and cannot perform it. ` +
              `Pass ActionContext.dispatch, or gate the affordance through availability() so it renders disabled-with-reason instead.`,
          );
        }
        return ctx.dispatch({ action: id, entityId: ctx.entityId });
      }),
  };
}

/** A permanently-unavailable verb: the R7/§10.7 disabled-with-reason home. */
function deferred(id: ActionRef, label: string, icon: IconRef, reason: string): ActionDef {
  return {
    id,
    label,
    icon,
    availability: () => disabled(reason),
    // Deliberately inert: an affordance may never advertise an action the
    // facade cannot perform (L6), and calling it is a no-op, not a throw.
    run: () => undefined,
  };
}

/**
 * Mark a verb as opening the D44 launch configuration before dispatch.
 *
 * `mode` is what the config COMMITS, carried as data so no surface has to ask
 * which verb opened it. Omitted ⇒ the config's own default (`worker`).
 */
function launching(action: ActionDef, mode?: LaunchMode): ActionDef {
  return mode ? { ...action, flow: 'launch', launchMode: mode } : { ...action, flow: 'launch' };
}

const ACTIONS: Readonly<Record<ActionRef, ActionDef>> = {
  open: define('open', 'Open', '↗', (ctx) => (ctx.entityId ? AVAILABLE : disabled(REASONS.noEntity))),

  create: define('create', 'Create', '＋', (ctx) => opGate(ctx, 'entities.create') ?? AVAILABLE),

  complete: define(
    'complete',
    'Complete',
    '✓',
    (ctx) =>
      opGate(ctx, 'tasks.complete') ?? capabilityGate(ctx, 'canComplete', REASONS.cannotComplete) ?? AVAILABLE,
  ),

  /**
   * D67 — write the row's state from the expanded list row.
   *
   * Gated on `canEdit`, NOT `canComplete`: this verb moves a row through its
   * ordinary lifecycle, and the one value that needs the completion gate
   * declares `via: 'complete'` in registry data so it dispatches the gated
   * verb instead. Keeping them separate is what stops "blocked" inheriting
   * completion's acceptance-criteria refusal.
   *
   * The payload (which state) rides `ActionIntent.payload`; the surface
   * dispatches directly because the value is a user choice, not a property of
   * the verb, and `run(ctx)` has no place to carry it.
   */
  'set-state': define(
    'set-state',
    'Set state',
    '◆',
    (ctx) => opGate(ctx, 'entities.commands.work') ?? capabilityGate(ctx, 'canEdit', REASONS.cannotEdit) ?? AVAILABLE,
  ),

  /**
   * D67 — the tombstone, the ONE lifecycle bit every kind shares.
   *
   * `entities.delete` is refused outright by the database for the kinds whose
   * lifecycle is command-owned (member, message, work_session, project,
   * interaction_profile: "entity lifecycle is command-owned for kind %"), and
   * that refusal reaches this gate as `canDelete: false` — server truth, not a
   * kind list duplicated in the client where it would drift.
   */
  archive: define(
    'archive',
    'Archive',
    '▢',
    (ctx) => opGate(ctx, 'entities.delete') ?? capabilityGate(ctx, 'canDelete', REASONS.cannotArchive) ?? AVAILABLE,
  ),

  restore: define(
    'restore',
    'Restore',
    '↺',
    (ctx) => opGate(ctx, 'entities.restore') ?? capabilityGate(ctx, 'canDelete', REASONS.cannotRestore) ?? AVAILABLE,
  ),

  pull: define(
    'pull',
    'Pull',
    '⇣',
    (ctx) => opGate(ctx, 'tasks.pull') ?? capabilityGate(ctx, 'canPull', REASONS.cannotPull) ?? AVAILABLE,
  ),

  link: define(
    'link',
    'Link',
    '⛓',
    (ctx) => opGate(ctx, 'edges.create') ?? capabilityGate(ctx, 'canLink', REASONS.cannotLink) ?? AVAILABLE,
  ),

  /**
   * Opens the kind's `editFields` dialog.
   *
   * GATED ON `entities.patch`, the operation the dialog actually dispatches —
   * not on `entities.commands.work`, which is the task-state verb and would
   * have let the button light up on a node that refuses the write it makes.
   */
  edit: define(
    'edit',
    'Edit',
    '✎',
    (ctx) => opGate(ctx, 'entities.patch') ?? capabilityGate(ctx, 'canEdit', REASONS.cannotEdit) ?? AVAILABLE,
  ),

  'add-child': define(
    'add-child',
    'Add child',
    '＋',
    (ctx) =>
      opGate(ctx, 'entities.create') ?? capabilityGate(ctx, 'canAddChild', REASONS.cannotAddChild) ?? AVAILABLE,
  ),

  react: define(
    'react',
    'React',
    '♡',
    (ctx) => opGate(ctx, 'reactions.set') ?? capabilityGate(ctx, 'canReact', REASONS.cannotReact) ?? AVAILABLE,
  ),

  'grant-points': define(
    'grant-points',
    'Grant points',
    '◆',
    (ctx) =>
      opGate(ctx, 'points.grant') ?? capabilityGate(ctx, 'canGrantPoints', REASONS.cannotGrantPoints) ?? AVAILABLE,
  ),

  // D44: Run and Coordinate open the launch configuration (teammate, model,
  // project, mode) rather than firing a bare spawn. The flow marker is DATA —
  // every surface reads it, so none of them can skip the config by accident.
  run: launching(
    define(
      'run',
      'Run',
      '▶',
      (ctx) => opGate(ctx, 'execution.spawn') ?? capabilityGate(ctx, 'canEdit', REASONS.cannotEdit) ?? AVAILABLE,
    ),
  ),

  coordinate: launching(
    define(
      'coordinate',
      'Coordinate',
      '⛭',
      (ctx) => opGate(ctx, 'execution.spawn') ?? capabilityGate(ctx, 'canEdit', REASONS.cannotEdit) ?? AVAILABLE,
    ),
    // The whole difference between this verb and Run: it spawns something that
    // directs its own workers. Without it the two are the same button.
    'coordinator',
  ),

  'launch-session': launching(
    define(
      'launch-session',
      'Launch session',
      '⚡',
      (ctx) => opGate(ctx, 'execution.spawn') ?? AVAILABLE,
    ),
  ),

  /**
   * A VANILLA TERMINAL (101) — the shell you get without an agent in front.
   *
   * NOT wrapped in `launching()`, and that is the whole difference from its
   * neighbour above. `launch-session` opens the quick config because a spawn
   * has a teammate, a model, a profile and a project to choose, and the ruling
   * behind that config is that a spawn's configuration must be visible at the
   * moment it is committed. A vanilla terminal HAS no configuration — no
   * persona, no model, no prompt — so an expand would show a card with nothing
   * in it and cost a second click to say so. It commits on click.
   *
   * Gated on its own operation, never on `execution.spawn`: a node that
   * refuses spawns (at the agent cap, say) can still open a terminal, because
   * the two caps are disjoint by construction. Gating on spawn would refuse a
   * terminal for a reason that does not apply to it.
   */
  'start-terminal': define(
    'start-terminal',
    'Terminal',
    '▮',
    (ctx) => opGate(ctx, 'execution.terminal.start') ?? AVAILABLE,
  ),

  terminate: define(
    'terminate',
    'Terminate',
    '⏻',
    /* `endableGate`, NOT `livenessGate` — see that function for the ruling and
       for why the node was never the obstacle. Terminate is how a row REACHES
       Done, so refusing it on everything that is not currently answering was
       refusing the one verb that fixes a stuck row. */
    (ctx) => opGate(ctx, 'execution.terminate') ?? endableGate(ctx) ?? AVAILABLE,
  ),

  /**
   * THE OTHER HALF OF THE PROCESS CONTROL — `execution.resume`.
   *
   * A finished session row used to offer two controls and neither worked: a
   * Terminate correctly refused with "this session has already ended", and a
   * tick that drew live, dispatched, wrote, and moved nothing (an `exited`
   * session resolves to `done` whatever the tick says — 156's own header says
   * so). Meanwhile the one verb that IS eligible on exactly those rows had no
   * button anywhere in the registry.
   *
   * NOT `launching()`. See the union member in `types.ts`: a resume restores a
   * configuration rather than choosing one, so there is nothing for a launch
   * config to ask.
   *
   * The gate is `resumableGate`, which is `endableGate`'s refusal inverted
   * through the one shared `hasEnded`. That is what makes the tail slot total:
   * for any row, exactly one of these two verbs is offered.
   */
  resume: define(
    'resume',
    'Resume',
    '↺',
    (ctx) => opGate(ctx, 'execution.resume') ?? resumableGate(ctx) ?? AVAILABLE,
  ),

  'prompt-session': define(
    'prompt-session',
    'Prompt session',
    '›',
    (ctx) => opGate(ctx, 'execution.prompt') ?? livenessGate(ctx) ?? AVAILABLE,
  ),

  // §10.7 register — the seam does not carry these commands yet.
  'share-into-session': deferred(
    'share-into-session',
    'Share into session',
    '⇥',
    REASONS.handoffSendDeferred,
  ),
  'withdraw-handoff': deferred('withdraw-handoff', 'Withdraw', '↩', REASONS.handoffWithdrawDeferred),

  'toggle-theme': define('toggle-theme', 'Toggle theme', '◐', () => AVAILABLE),

  /**
   * B10 — RETIRED FROM THE R7 TABLE by `tracking.pr.merge` (#184). It sat here
   * as `deferred` carrying "this node only has the read-only tracker"; that
   * precondition is now false, and leaving the authored copy in place would be
   * this package asserting an absence the seam has since filled.
   *
   * It gates on the OP ONLY. The refusals that decide whether this particular
   * PR can land — not open, conflicted, red CI, no credential — are read from
   * observed facts `ActionContext` does not carry, and putting them here would
   * mean teaching the shared context one kind's vocabulary (§15.2). They are
   * answered by the flow, which is why the label keeps its ellipsis: the verb
   * promises a confirm, not a merge.
   *
   * `opUnavailable['tracking.pr.merge']` is the ONE gate it does keep, and it
   * is what makes the 501 from a node predating the merge door a first-class
   * rendering rather than an error: the shell caches that verdict and this
   * verb reads it back as disabled-with-reason on every later surface.
   */
  'merge-pr': {
    ...define(
      'merge-pr',
      'Merge…',
      '⇣',
      (ctx) => opGate(ctx, 'tracking.pr.merge') ?? (ctx.entityId ? AVAILABLE : disabled(REASONS.noEntity)),
    ),
    flow: 'merge-pr',
  },

  // R7 disposition table (LLD §4.2) — every deferred member has a home.
  //
  // `graph-view` LEFT THIS TABLE on 2026-08-15, and it left the `ActionRef`
  // union with it rather than becoming a live verb. Graph is reached the way
  // every other screen is reached — through the navigation vocabulary
  // (`{ view: 'graph' }`, the rail, the palette's view rows), not through a
  // verb — so there was no live action underneath the deferral waiting to be
  // uncovered. Keeping the ref as an available no-op would have traded a
  // stale refusal for an enabled-inert affordance, which is the worse lie.
  undo: deferred('undo', 'Undo', '↶', REASONS.undoDeferred),
  'version-history': deferred('version-history', 'Version history', '⟲', REASONS.versionHistoryDeferred),
  leaderboard: deferred('leaderboard', 'Leaderboard', '☰', REASONS.leaderboardDeferred),
  awards: deferred('awards', 'Awards', '★', REASONS.awardsDeferred),
  'saved-views': deferred('saved-views', 'Saved views', '▤', REASONS.savedViewsDeferred),
  'search-results': deferred('search-results', 'Open full results', '⌕', REASONS.searchResultsDeferred),
  'activity-screen': deferred('activity-screen', 'Activity', '◷', REASONS.activityScreenDeferred),
  'add-server': deferred('add-server', 'Add server', '＋', REASONS.addServerDeferred),
  // T0-4 kind primaries (Surface Audit 2026-07-29). Deferred = renders
  // disabled-with-reason wherever a registry row carries it (R7); each flips
  // to available when its executor lands, with no consumer edit.
  equip: deferred('equip', 'Equip', '⊕', REASONS.equipDeferred),
  refresh: deferred('refresh', 'Refresh', '⟳', REASONS.refreshDeferred),
  untrust: deferred('untrust', 'Untrust', '⛨', REASONS.untrustDeferred),
  unlink: deferred('unlink', 'Unlink', '⊘', REASONS.unlinkDeferred),
  'set-as-default': deferred('set-as-default', 'Set as default', '◎', REASONS.setAsDefaultDeferred),
  'mark-read': deferred('mark-read', 'Mark read', '✓', REASONS.markReadDeferred),
  quote: deferred('quote', 'Quote', '❝', REASONS.quoteDeferred),

  /*
   * CONTAINER LIFECYCLE (Design §13.1). Each gates on its OWN catalog
   * operation and its OWN capability boolean — never on a shared one.
   *
   * WHY EACH VERB NAMES ITS OWN OP. `TM8_CONTAINERS=off` answers 501
   * `not_implemented` for every runtime op, and the shell caches that verdict
   * per operation in `ctx.opUnavailable`. Gating all five on, say,
   * `containers.start` would light four buttons a node has refused, and hide
   * one it has not.
   */
  'container-start': define(
    'container-start',
    'Start',
    '▶',
    (ctx) =>
      opGate(ctx, 'containers.start')
      ?? containerCapabilityGate(ctx, 'canStart', CONTAINER_CAPABILITY_REASONS.canStart)
      ?? AVAILABLE,
  ),

  'container-stop': define(
    'container-stop',
    'Stop',
    '⏸',
    (ctx) =>
      opGate(ctx, 'containers.stop')
      ?? containerCapabilityGate(ctx, 'canStop', CONTAINER_CAPABILITY_REASONS.canStop)
      ?? AVAILABLE,
  ),

  /*
   * DESTROY IS THE IRREVERSIBLE DIRECTION, unlike `terminate` next door — a
   * terminated session resumes, a destroyed container does not: the runtime is
   * gone and the row is soft-deleted for history (§11.1, `destroyed` is
   * terminal). The confirm is the DISPATCHER's, not this verb's: `ActionDef`
   * offers `flow` for a configuration or a confirmation surface, and a destroy
   * needs neither a config nor facts this context does not carry — it needs a
   * yes. `usePanelPrimaries` asks for it.
   */
  'container-destroy': define(
    'container-destroy',
    'Destroy',
    '⏻',
    (ctx) =>
      opGate(ctx, 'containers.destroy')
      ?? containerCapabilityGate(ctx, 'canDestroy', CONTAINER_CAPABILITY_REASONS.canDestroy)
      ?? AVAILABLE,
  ),

  /*
   * Opens an exec PTY IN the container — `containers.terminal.start`, which is
   * live in P0 and mints a `work_session(session_kind='container_exec')`. The
   * session it returns is an ordinary work_session with the terminal panel the
   * app already has, so this verb builds no terminal of its own; it creates
   * the session and the host opens it.
   *
   * Gated on `canExec` (status `running`), NOT on `canAttach`: attaching is
   * about a non-terminal SURFACE, and the two are separate booleans precisely
   * because a container can exec without having a screen.
   */
  'container-terminal': define(
    'container-terminal',
    'Terminal',
    '▮',
    (ctx) =>
      opGate(ctx, 'containers.terminal.start')
      ?? containerCapabilityGate(ctx, 'canExec', CONTAINER_CAPABILITY_REASONS.canExec)
      ?? AVAILABLE,
  ),

  /*
   * THE SCREEN SURFACE IS NOT BUILT IN P0, and this says so out loud rather
   * than by being missing (R7, and the DEF-003 lesson: "a surface removed
   * without a word is a surface nobody can report missing").
   *
   * `deferred`, so it refuses in EVERY context — which is also what keeps
   * `panel-primaries-wired.test.tsx`'s `refusedByNarrowing` empty without a
   * dispatcher entry: a verb with no executor is safe only when its own
   * availability refuses, never when it relies on `wiredActions` narrowing.
   * The day the viewer lands, this becomes a `define(...)` gated on
   * `containers.attach` + `canAttach`, and no consumer changes.
   */
  'container-screen': deferred('container-screen', 'Screen', '▭', REASONS.containerScreenDeferred),

  /*
   * THE BIRTH VERB. It opens `NewContainerSheet` and commits
   * `containers.create` — NEVER `entities.create`, which the node refuses for
   * this kind ("owned by the container lifecycle") exactly as it does for
   * work_session.
   *
   * Gated on `containers.create` and nothing else: a create has no entity to
   * hold capabilities, so `capabilityGate` has no subject. The sheet owns the
   * refusals that depend on facts this context does not carry (no provider
   * satisfies the profile, the node is at its cap) — the same division
   * `merge-pr` draws between its verb and its confirm.
   */
  'new-container': define('new-container', 'New container', '＋', (ctx) => opGate(ctx, 'containers.create') ?? AVAILABLE),
};

/** Resolve a ref to its definition. Total over `ActionRef` — never throws. */
export function resolveAction(ref: ActionRef): ActionDef {
  return ACTIONS[ref];
}

export function allActions(): ActionDef[] {
  return Object.values(ACTIONS);
}

/**
 * The R7 discovery set: the palette renders exactly these as disabled rows.
 * Derived, not a second list — a deferred action cannot fall out of the
 * palette by being forgotten.
 */
export function deferredActions(): ActionDef[] {
  const probe = { spaceId: 'probe' } as const;
  return allActions().filter((a) => a.availability(probe).kind === 'disabled' && isAlwaysDisabled(a));
}

function isAlwaysDisabled(action: ActionDef): boolean {
  // An always-disabled action refuses even with every gate satisfied.
  const permissive = {
    spaceId: 'probe',
    entityId: 'probe-entity',
    liveness: 'live' as const,
    capabilities: {
      canEdit: true,
      canDelete: true,
      canAddChild: true,
      canLink: true,
      canPull: true,
      canReact: true,
      canGrantPoints: true,
      canComplete: true,
    },
  };
  return action.availability(permissive).kind === 'disabled';
}
