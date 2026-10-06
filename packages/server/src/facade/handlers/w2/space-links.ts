/**
 * `spaceLinks.*` (W6, migrations 250/251) — registration and request
 * adaptation over `DbSpaceLinkStore`.
 *
 * `spaceLinks.list` is open to every home member: it carries no secret, and
 * an agent needs it to know which linked spaces its human has signed in to.
 * The six writes are HUMAN-ONLY, twice: `requireHumanLinkSession` here reads the
 * server-resolved `ctx.identity.authKind`, and every write RPC in 251 calls
 * the strict `internal.require_human_auth_kind()` on the bound claim. A `link`
 * session is refused by both, so a link can never manage links.
 *
 * The TARGET side (278, owner decision D2): `spaceLinks.inbound.*` answers an
 * admin of the path's `:spaceId` only — the links into it, the calls made
 * through them, and revoke/restore. SQL holds the session pin, so owning both
 * spaces is no shortcut (D7): the admin acts from the target. revoke and
 * restore are human-only like every other link write.
 *
 * No handler returns the stored session. `use` is not an operation: W7's
 * `spaceLinks.invoke` calls it server-side and never returns the bytes.
 *
 * ACROSS SERVERS (W9c, 299), only while `TM8_REMOTE_SPACE_LINKS` is on:
 * `add` takes a `targetServerId`; `login`/`relogin` take the `pairingCode` the
 * target's `spaceLinks.inbound.grant` returned and claim it server-to-server;
 * `logout`/`remove` first tell the target to end its session (best effort,
 * the target's own revoke works without us). The target side's three wire
 * routes are `createRemoteSpaceLinkRoute`, handed out through `onRemoteRoute`.
 */
import {
  CollabError,
  SpaceLinksAddInputSchema,
  SpaceLinksInboundGrantInputSchema,
  SpaceLinksInboundMutationInputSchema,
  SpaceLinksLoginInputSchema,
  SpaceLinksMutationInputSchema,
  SpaceLinksSetSpawnInputSchema,
  isHumanAuthKind,
} from '@tm8/contract';
import type {
  SpaceLinkInboundAuditEntry,
  SpaceLinkInboundView,
  SpaceLinkView,
  SpaceLinksInboundGrantResult,
} from '@tm8/contract';

import type { OperationHandler, RequestContext } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { claimsFor } from '../../context.js';
import type { DbClaims } from '../../../db/types.js';
import { DbSpaceLinkStore } from '../../../credentials/space-link-store.js';
import type { RemoteLinkClientOptions } from '../../../remote/link-client.js';
import { claimRemoteLink, loadOrCreateRemoteNodeId, revokeRemoteLink } from '../../../remote/link-pairing.js';
import { SPACE_LINK_REMOTE_DISABLED, createSpaceLinkInvokeHandlers, type SpaceLinkInvokeOptions } from './space-link-invoke.js';
import { createRemoteSpaceLinkRoute, type RemoteSpaceLinkRoute, type RemoteSpaceLinkRouteOptions } from './space-link-remote-route.js';
import { createCrossSpaceRefHandlers } from './cross-space-refs.js';

/** The typed refusal code. Stable, and asserted by test. */
export const SPACE_LINKS_HUMAN_ONLY = 'space_links_human_only';

/** Layer 1 of the human-only rule; fails closed on an absent kind. */
export function requireHumanLinkSession(handler: OperationHandler): OperationHandler {
  return async (ctx) => {
    const kind = ctx.identity.authKind;
    if (!isHumanAuthKind(kind)) {
      throw new CollabError(
        'forbidden',
        'space link management is available to human sessions only',
        { details: { reason: SPACE_LINKS_HUMAN_ONLY } },
      );
    }
    return handler(ctx);
  };
}

export interface SpaceLinkHandlerDeps {
  /** Node data root: the node key that seals stored link sessions. */
  dataDir: string;
  /**
   * Built by the composition root when it wires `onStale` (W7-bound: see
   * `DbSpaceLinkStoreOptions.onStale`); defaults to a plain store.
   */
  store?: DbSpaceLinkStore;
  /** W7 invoke tuning (the per-token-row bucket); defaults are production's. */
  invoke?: SpaceLinkInvokeOptions;
  /**
   * W9c. Only read while `config.remoteSpaceLinks` is on. `client` overrides
   * the outbound client (tests: the guard's resolver/transport); `onRoute`
   * receives the target-side wire route for the composition root to mount.
   */
  remote?: {
    client?: RemoteLinkClientOptions;
    route?: RemoteSpaceLinkRouteOptions;
    onRoute?: (route: RemoteSpaceLinkRoute) => void;
  };
}

function remoteDisabled(): CollabError {
  return new CollabError('forbidden', 'remote space links are disabled on this node (TM8_REMOTE_SPACE_LINKS)', {
    details: { reason: SPACE_LINK_REMOTE_DISABLED },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pathParam(ctx: RequestContext, name: 'spaceId' | 'linkId'): string {
  const value = ctx.params[name];
  if (!value) throw new CollabError('invalid_input', `${name} is required`);
  return value;
}

export function registerSpaceLinkHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  links: SpaceLinkHandlerDeps,
): void {
  const store = links.store ?? new DbSpaceLinkStore({ db: deps.db, dataDir: links.dataDir });
  const claimsOf = async (ctx: RequestContext) => {
    const claims = claimsFor(await deps.owner(), ctx);
    if (!claims.identityId) throw new CollabError('unauthenticated', 'no identity resolved for this request');
    return claims;
  };

  const list: OperationHandler = async (ctx): Promise<SpaceLinkView[]> =>
    store.list(await claimsOf(ctx), pathParam(ctx, 'spaceId'));

  const remoteOn = deps.config.remoteSpaceLinks === true;
  const client: RemoteLinkClientOptions = {
    ...(deps.config.remoteSpaceLinksAllowLoopback === true ? { allowLoopback: true } : {}),
    ...links.remote?.client,
  };

  const add: OperationHandler = async (ctx): Promise<SpaceLinkView> => {
    const { targetSpaceId, targetServerId, alias, clientMutationId } = SpaceLinksAddInputSchema.parse(ctx.body);
    if (targetServerId) {
      if (!remoteOn) throw remoteDisabled();
      return store.addRemote(await claimsOf(ctx), {
        spaceId: pathParam(ctx, 'spaceId'), serverId: targetServerId, targetSpaceId, alias: alias ?? null, clientMutationId,
      });
    }
    return store.add(await claimsOf(ctx), {
      spaceId: pathParam(ctx, 'spaceId'), targetSpaceId, alias: alias ?? null, clientMutationId,
    });
  };

  const login = (relogin: boolean): OperationHandler => async (ctx): Promise<SpaceLinkView> => {
    const { pairingCode, clientMutationId } = SpaceLinksLoginInputSchema.parse(ctx.body);
    const linkId = pathParam(ctx, 'linkId');
    const claims = await claimsOf(ctx);
    if (!pairingCode) {
      if (remoteOn && (await store.remoteContext(claims, linkId)).targetServerId) {
        throw new CollabError('invalid_input',
          'this link targets a space on another server: pass the pairing code from `spaceLinks.inbound.grant` there',
          { details: { reason: 'space_link_pairing_required' } });
      }
      return store.login(claims, linkId, { relogin, clientMutationId });
    }
    if (!remoteOn) throw remoteDisabled();
    const context = await store.remoteContext(claims, linkId);
    if (!context.targetServerId || !context.baseUrl) {
      throw new CollabError('invalid_input', 'this link targets a space on this server: sign in without a pairing code');
    }
    const claimed = await claimRemoteLink({
      baseUrl: context.baseUrl,
      pairingCode,
      homeSpaceId: context.homeSpaceId,
      homeServerId: await loadOrCreateRemoteNodeId(links.dataDir),
      homeBaseUrl: deps.config.publicOrigin ?? null,
    }, client);
    if (claimed.targetSpaceId.toLowerCase() !== context.targetSpaceId.toLowerCase()) {
      // The code was granted for another space: end what was just minted, store nothing.
      await revokeRemoteLink({ baseUrl: context.baseUrl, token: claimed.token }, client).catch(() => false);
      throw new CollabError('invalid_input', 'the pairing code was granted for a different target space than this link', {
        details: { reason: 'space_link_pairing_target_mismatch' },
      });
    }
    return store.storeRemoteSession(claims, linkId,
      { token: claimed.token, remoteSessionId: claimed.sessionId, expiresAt: claimed.expiresAt },
      { relogin, clientMutationId });
  };

  /**
   * Before a logout or remove: tell the target to end the session it minted,
   * so it does not outlive the link here. Best effort and never blocking —
   * the target's own revoke (its admins, or the member there) works without us.
   */
  const revokeAtTarget = async (claims: DbClaims, linkId: string): Promise<void> => {
    if (!remoteOn) return;
    try {
      const context = await store.remoteContext(claims, linkId);
      if (!context.targetServerId || !context.baseUrl || context.status !== 'signed_in') return;
      const token = await store.openRemote(claims, linkId);
      if (!(await revokeRemoteLink({ baseUrl: context.baseUrl, token }, client))) {
        console.warn('[space-link] the target server did not confirm the remote session revoke', { linkId });
      }
    } catch (error) {
      console.warn('[space-link] remote session revoke failed', {
        linkId, reason: error instanceof Error ? error.name : 'unknown',
      });
    }
  };

  const logout: OperationHandler = async (ctx): Promise<SpaceLinkView> => {
    const { clientMutationId } = SpaceLinksMutationInputSchema.parse(ctx.body);
    const claims = await claimsOf(ctx);
    await revokeAtTarget(claims, pathParam(ctx, 'linkId'));
    return store.logout(claims, pathParam(ctx, 'linkId'), clientMutationId);
  };

  const remove: OperationHandler = async (ctx): Promise<SpaceLinkView> => {
    const { clientMutationId } = SpaceLinksMutationInputSchema.parse(ctx.body);
    const claims = await claimsOf(ctx);
    await revokeAtTarget(claims, pathParam(ctx, 'linkId'));
    return store.remove(claims, pathParam(ctx, 'linkId'), clientMutationId);
  };

  // W9c, on the TARGET: a member of :spaceId lets a space on another server act here as them.
  const inboundGrant: OperationHandler = async (ctx): Promise<SpaceLinksInboundGrantResult> => {
    const { homeSpaceId, homeLabel, allowSpawn } = SpaceLinksInboundGrantInputSchema.parse(ctx.body);
    if (!remoteOn) throw remoteDisabled();
    const spaceId = pathParam(ctx, 'spaceId');
    const granted = await store.grantInbound(await claimsOf(ctx), {
      spaceId, homeSpaceId, homeLabel: homeLabel ?? null, allowSpawn: allowSpawn ?? false,
    });
    return { ...granted, targetSpaceId: spaceId };
  };

  const setSpawn: OperationHandler = async (ctx): Promise<SpaceLinkView> => {
    const { allowSpawn, spawnBudget, clientMutationId } = SpaceLinksSetSpawnInputSchema.parse(ctx.body);
    return store.setSpawn(await claimsOf(ctx), {
      linkId: pathParam(ctx, 'linkId'), allowSpawn, spawnBudget: spawnBudget ?? null, clientMutationId,
    });
  };

  const inboundList: OperationHandler = async (ctx): Promise<SpaceLinkInboundView[]> =>
    store.listInbound(await claimsOf(ctx), pathParam(ctx, 'spaceId'));

  const inboundAudit: OperationHandler = async (ctx): Promise<SpaceLinkInboundAuditEntry[]> => {
    const linkId = ctx.query.get('linkId');
    if (linkId !== null && !UUID_RE.test(linkId)) throw new CollabError('invalid_input', 'linkId must be a space link id');
    const limit = Number(ctx.query.get('limit') ?? 50);
    return store.listInboundAudit(await claimsOf(ctx), pathParam(ctx, 'spaceId'), {
      linkId,
      limit: Number.isFinite(limit) ? limit : 50,
      before: ctx.query.get('before'),
    });
  };

  const inboundWrite = (revoke: boolean): OperationHandler => async (ctx): Promise<SpaceLinkInboundView> => {
    const { clientMutationId } = SpaceLinksInboundMutationInputSchema.parse(ctx.body);
    const args = [await claimsOf(ctx), pathParam(ctx, 'spaceId'), pathParam(ctx, 'linkId'), clientMutationId] as const;
    return revoke ? store.revokeInbound(...args) : store.restoreInbound(...args);
  };

  // W7. invoke is NOT human-only: it is the agent's door. Its own guard
  // (space-link-invoke.ts) refuses the refused set before anything is opened.
  const { invoke, audit } = createSpaceLinkInvokeHandlers(registry, deps, store, claimsOf, links.invoke);
  // L3 (279): references into a linked space, made through the same invoke.
  const refs = createCrossSpaceRefHandlers(deps, store, claimsOf, invoke);
  // W9c: the target-side wire. Built always (it answers nothing while the switch is off).
  links.remote?.onRoute?.(createRemoteSpaceLinkRoute(registry, deps, store, claimsOf, links.remote.route));

  // Every write is wrapped; `list`, `audit`, `invoke` and the two inbound
  // reads are open (the inbound reads to the target's admins, in SQL).
  registry.registerAll({
    'spaceLinks.list': list,
    'spaceLinks.audit': audit,
    'spaceLinks.inbound.list': inboundList,
    'spaceLinks.inbound.audit': inboundAudit,
    'spaceLinks.inbound.revoke': requireHumanLinkSession(inboundWrite(true)),
    'spaceLinks.inbound.restore': requireHumanLinkSession(inboundWrite(false)),
    'spaceLinks.inbound.grant': requireHumanLinkSession(inboundGrant),
    'spaceLinks.invoke': invoke,
    'entities.refs.list': refs.list,
    'entities.refs.add': refs.add,
    'entities.refs.remove': refs.remove,
    'spaceLinks.add': requireHumanLinkSession(add),
    'spaceLinks.login': requireHumanLinkSession(login(false)),
    'spaceLinks.relogin': requireHumanLinkSession(login(true)),
    'spaceLinks.logout': requireHumanLinkSession(logout),
    'spaceLinks.remove': requireHumanLinkSession(remove),
    'spaceLinks.setSpawn': requireHumanLinkSession(setSpawn),
  });
}
