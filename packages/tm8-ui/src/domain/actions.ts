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
  livenessUnknown: 'Liveness is unverified on this node right now — the session cannot be acted on until it is confirmed.',
  // §10.7 deferred seam amendments (dual re-consensus pending)
  handoffSendDeferred:
    'Sharing into a session is not wired yet: handoffs.send is not in the stamped facade seam. The affordance is real; the operation is not available.',
  handoffWithdrawDeferred:
    'Withdrawing a handoff is deferred: handoffs.withdraw is not in the stamped facade seam, and withdrawal is not reversible once it is.',
  // R7 deferred features (never hidden, never built)
  graphDeferred: 'Graph view isn’t available yet.',
  undoDeferred: 'Undo isn’t available yet — actions in this build are not reversible.',
  versionHistoryDeferred: 'Version history isn’t available yet.',
  leaderboardDeferred: 'The leaderboard isn’t available yet.',
  awardsDeferred: 'Awards aren’t available yet.',
  savedViewsDeferred: 'Saved views and axis management aren’t available yet.',
  searchResultsDeferred: 'A full search results view isn’t available yet — the palette is the search surface.',
  activityScreenDeferred: 'The activity screen isn’t available yet.',
  addServerDeferred: 'Remote servers arrive in Phase 2 — this node is the only one wired.',
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

  terminate: define(
    'terminate',
    'Terminate',
    '⏻',
    (ctx) => opGate(ctx, 'execution.terminate') ?? livenessGate(ctx) ?? AVAILABLE,
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

  // R7 disposition table (LLD §4.2) — every deferred member has a home.
  'graph-view': deferred('graph-view', 'Graph view', '◈', REASONS.graphDeferred),
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
