/**
 * The facade block: the handler registry, the operation→input-schema table,
 * and the one function the composition root calls to mount everything.
 *
 * Derived truth (EntityDetail assembly, capabilities, badges, PullState,
 * titles/excerpts/tombstones) is computed server-side and lives in
 * ./entity-read.ts — the contract's rule is that the client never derives, it
 * renders (L3).
 *
 * WHAT IS MOUNTED, AND WHAT DELIBERATELY IS NOT. `registerFacadeHandlers`
 * registers exactly the operations that are BUILT. Everything else keeps
 * answering an honest `501 not_implemented` (DEV-13) — the registry's whole
 * design point. So the list below is not a to-do written as code: it is the
 * truthful answer to "what does this node actually do?", and `/health` reports
 * its size.
 */
export { HandlerRegistry } from './registry.js';
export { INPUT_SCHEMAS, UNBOUND_COMMAND_OPERATIONS } from './input-schemas.js';
export type { FacadeDeps } from './deps.js';

/**
 * The single EntitySummary assembler. Exported as a plain function, free of any
 * handler or registry coupling, so the event stream projects entities through
 * the SAME code the REST reads use. Two assemblers would let a WorkspaceEvent
 * and an `entities.get` disagree about one entity — for some kinds and not
 * others, which is the kind of divergence that ships unnoticed.
 */
export {
  assembleSummaries,
  loadEntitySummariesByIds,
  toEntitySummary,
  capabilitiesOf,
  contentOf,
  ENTITY_COLUMNS,
  ENTITY_FROM,
  type EntityRow,
} from './entity-read.js';

export { queryCollection } from './handlers/collections.js';
export { buildDetail } from './handlers/entities.js';
export { loadActivity } from './handlers/activity.js';

import { HandlerRegistry } from './registry.js';
import type { Db } from '../db/types.js';
import type { ServerConfig } from '../http/config.js';
import { createLoopbackOwnerResolver } from '../identity/loopback.js';
import type { FacadeDeps } from './deps.js';
import type { W2FilesServiceOptions } from './services/w2/files.js';

import { registerW2AuthHandlers } from './handlers/w2/auth.js';
import { registerW2EdgesPlacementsHandlers } from './handlers/w2/edges-placements.js';
import { registerW2EntitiesCommandsTrackingHandlers } from './handlers/w2/entities-commands-tracking.js';
import { registerW2EntityKindsProfileHandlers } from './handlers/w2/entity-kinds-profiles.js';
import { registerW2FeedContextHandlers } from './handlers/w2/feed-context.js';
import { registerW2FileHandlers } from './handlers/w2/files.js';
import { registerW2ArtifactHandlers } from './handlers/w2/artifacts.js';
import { registerW2CollectionsGraphUndoHandlers } from './handlers/w2/graph-undo.js';
import { registerW2IdentitySpacesHandlers } from './handlers/w2/identity-spaces.js';
import { registerW2InboxReadMarksHandlers } from './handlers/w2/inbox-read-marks.js';
import { registerW2MenuDefaultChannelHandlers } from './handlers/w2/menu-default-channel.js';
import {
  registerW2MessagesHandoffsHandlers,
  type W2MessagesHandoffsServiceOptions,
} from './handlers/w2/messages-handoffs.js';
import { registerW2ProjectsAssociationsHandlers } from './handlers/w2/projects-associations.js';
import { registerW2SavedViewsActionsHandlers } from './handlers/w2/saved-views-actions.js';
import { registerContentionHandlers } from './services/contention.js';
import { registerW2ServerConnectionHandlers } from './handlers/w2/server-connections.js';
import {
  registerCredentialHandlers,
  type CredentialHandlerDeps,
} from './handlers/w2/credentials.js';
import { registerVoiceHandlers } from './handlers/voice.js';

export interface RegisterFacadeHandlersDeps {
  readonly db: Db;
  readonly config: ServerConfig;
  readonly owner?: FacadeDeps['owner'];
  readonly files?: W2FilesServiceOptions;
  /**
   * W2 B2's live-delivery seam, and the ONE deliberate exception to the rule
   * `deps.ts` states in its own header.
   *
   * It is a parameter HERE and not a field on `FacadeDeps` on purpose, and the
   * distinction is the whole safeguard. `FacadeDeps` reaches every handler; a
   * field on it would turn one reviewed decision into a permanently open door
   * for every seam that comes after. This parameter reaches exactly one call —
   * `registerW2MessagesHandoffsHandlers` below — so the blast radius is visible
   * in the signature and cannot widen without another edit here.
   *
   * What it carries is a SECOND DATABASE IDENTITY: a pool authenticating as
   * `tm8_delivery_worker`, which `internal.require_delivery_principal` demands
   * and which `tm8_app` provably cannot assume (pg_catalog: no membership, no
   * EXECUTE on any of the three delivery RPCs). That is precisely what the
   * narrow shape exists to make expensive, and it stayed expensive: it could
   * not be reached from inside the tree, so it had to be decided here.
   */
  readonly messageDelivery?: W2MessagesHandoffsServiceOptions['messageDelivery'];
  /**
   * Server-owned message provenance resolver. Optional because the default
   * below covers the token-pinned case; `main.ts` overrides it with the
   * envelope-aware resolver, which also reconciles a claimed `workSessionId`
   * against the pinned one.
   */
  readonly resolveAuthoredFromWorkSessionId?: W2MessagesHandoffsServiceOptions['resolveAuthoredFromWorkSessionId'];
  /**
   * Tier B per-member credentials (sub-doc 11 §D).
   *
   * OPTIONAL, and a parameter HERE rather than a field on `FacadeDeps`, for the
   * reason this file's own header gives above: it reaches exactly one call, so
   * its blast radius is visible in the signature.
   *
   * What it carries is a PTY HOST and a filesystem root — the login terminal is
   * a real process started as the tm8 OS user. Neither is derivable inside the
   * facade: `PtyHostService` is built by `createExecutionRuntime` and `dataDir`
   * is resolved in the composition root. A node that has no execution runtime
   * (no database, or a test harness) simply does not mount these four, which is
   * the same conditional shape `deps.files` already uses.
   */
  readonly credentials?: CredentialHandlerDeps;
}

/**
 * Mount the built operations onto the registry.
 *
 * Called once, by `main.ts`, with a `Db` the composition root owns. Nothing in
 * this block constructs a pool or resolves configuration for itself — a second
 * pool created deeper in the tree is a pool nobody closes.
 */
export function registerFacadeHandlers(
  registry: HandlerRegistry,
  deps: RegisterFacadeHandlersDeps,
): void {
  const facade: FacadeDeps = {
    db: deps.db,
    config: deps.config,
    owner: deps.owner ?? createLoopbackOwnerResolver(deps.db),
  };

  /**
   * G02 is registered FIRST among the W2 seams, and it is the only owner of the
   * universal entity surface.
   *
   * The eight operations it shares with the pre-W2 wrappers — `entities.get`,
   * `create`, `patch`, `children`, `activity`, `points.add`, and the two
   * `entities.commands.*` transitions — are REPLACED here, not merged: they were
   * deleted from the inline block rather than left in place. `register()` throws
   * on a duplicate name, so there is no version of this file where both are
   * mounted and the difference goes unnoticed; and two entity readers would let
   * `entities.get` and `entities.children` disagree about the same row.
   */
  registerW2EntitiesCommandsTrackingHandlers(registry, facade);
  registerW2IdentitySpacesHandlers(registry, facade);
  // auth.* (Identity v2 Stage 1): local accounts over the 007 RPC surface.
  registerW2AuthHandlers(registry, facade);
  registerW2ServerConnectionHandlers(registry, facade);
  registerW2EdgesPlacementsHandlers(registry, facade);
  registerW2CollectionsGraphUndoHandlers(registry, facade);
  registerW2ProjectsAssociationsHandlers(registry, facade);
  // Tier 4 git×graph: the read-only file-contention map over active worktrees.
  registerContentionHandlers(registry, facade);
  // Voice reads its LiveKit deployment off the already-resolved config rather
  // than the environment: one place decides what this node is pointed at.
  registerVoiceHandlers(registry, facade, deps.config.livekit);
  if (deps.files) registerW2FileHandlers(registry, facade, deps.files);
  if (deps.files) registerW2ArtifactHandlers(registry, facade, { blobStore: deps.files.blobStore });
  registerW2InboxReadMarksHandlers(registry, facade);
  registerW2SavedViewsActionsHandlers(registry, deps);

  /**
   * G04 is the second seam to REPLACE rather than only add. It owns
   * `messages.list` and `messages.post`, both of which this function used to
   * register inline from `./handlers/messages.js` — the second of them as an
   * unconditional `501 not_implemented` stub, which is why nobody could send a
   * message on this node. Those two lines were DELETED above, not left beside
   * this call: `register()` throws on a duplicate name, so a build that kept
   * both would not boot rather than silently prefer one.
   *
   * `messages.list` is the same `messagesList(deps)` reader in both places, so
   * the swap is behaviour-preserving there. `messages.post` is the one operation
   * in this tranche whose behaviour changes rather than begins.
   *
   * G04's service casts `ctx.body` straight to its contract DTO instead of
   * parsing it, so composing it also required binding its five remaining
   * commands in `./input-schemas.ts`. Mounting it without them would put
   * unvalidated input in front of a handler that assumes the contract shape.
   */
  registerW2MessagesHandoffsHandlers(registry, facade, {
    ...(deps.messageDelivery ? { messageDelivery: deps.messageDelivery } : {}),
    resolveAuthoredFromWorkSessionId: deps.resolveAuthoredFromWorkSessionId
      ?? (async (ctx) => (ctx.identity.kind === 'bearer' ? ctx.identity.workSessionId ?? null : null)),
  });

  /**
   * G12, G13 and G14 are pure additions — no operation below was registered by
   * any seam above, so nothing here replaces anything. Each parses its own
   * request bodies, which is why none of them appear in `INPUT_SCHEMAS`.
   *
   * G13 is registered AFTER G09 (`registerW2SavedViewsActionsHandlers`) on
   * purpose: `entities.context` serves its `actions` section through G09's
   * discoverer, so that seam must already be on the registry when the feed
   * service is constructed.
   */
  registerW2EntityKindsProfileHandlers(registry, facade);
  registerW2FeedContextHandlers(registry, facade);
  registerW2MenuDefaultChannelHandlers(registry, facade);

  /**
   * Tier B credentials. Conditional on the seam for the same reason `files` is:
   * these four operations start and kill real processes, and a composition
   * without a PTY host cannot honestly answer them.
   *
   * The human-only guard (R2) is applied INSIDE `registerCredentialHandlers`,
   * over the whole record at once. It is deliberately not applied here — a
   * guard the call site has to remember to add is a guard the fifth call site
   * forgets.
   */
  if (deps.credentials) registerCredentialHandlers(registry, facade, deps.credentials);
}
