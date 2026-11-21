import { randomUUID } from 'node:crypto';
import type { VaultOutput } from '@tm8/contract';
import {
  memberScope, StoreNotFoundError, StoreStateError, VaultError, type BrokerCoreOp, type HandlersFor, type HandlerContext, type PolicyInput,
} from '../../core-types.js';
import { CONNECTORS } from '../../egress/connectors.js';
import { canonicalJson } from '../../intent/hash.js';
import { normalizeOrigin, OriginRefusal } from '../../origin/normalize.js';
import { createCaptureHandlers } from './captures.js';
import { createImportHandlers } from './imports.js';
import {
  appendAudit, assertOwnerSession, auditView, checkVersion, getItem, grantView, itemDetail, itemView, scanMetadata,
} from './shared.js';

function normalize(ctx: HandlerContext, value: string, devMode: boolean): string {
  scanMetadata(ctx, [value]);
  try { return normalizeOrigin(value, { devMode }).origin; }
  catch (error) { if (error instanceof OriginRefusal) throw VaultError.reason('origin_refused'); throw error; }
}

function validatePolicy(ctx: HandlerContext, policy: PolicyInput): void {
  scanMetadata(ctx, [policy.connector, ...policy.hosts, ...policy.pathPrefixes,
    ...(policy.injection.kind === 'basic' ? [policy.injection.username] : []),
    ...(policy.injection.kind === 'header' ? [policy.injection.name, policy.injection.prefix] : [])]);
  for (const host of policy.hosts) {
    try {
      const parsed = normalizeOrigin(`https://${host}`);
      if (parsed.host !== host || parsed.port !== null) throw new VaultError('invalid_input');
    } catch { throw new VaultError('invalid_input'); }
  }
  if (new Set(policy.hosts).size !== policy.hosts.length || new Set(policy.methods).size !== policy.methods.length
    || policy.pathPrefixes.some((path) => /[?#;\\\u0000-\u0020]/.test(path) || /%2f|%5c|%00/i.test(path)
      || path.split('/').some((segment) => segment === '.' || segment === '..'))) throw new VaultError('invalid_input');
  if (policy.mode === 'connector') {
    const connector = policy.connector ? CONNECTORS[policy.connector] : undefined;
    if (!connector || policy.hosts.some((host) => !connector.hosts.includes(host))
      || canonicalJson(policy.injection) !== canonicalJson(connector.injection)) throw new VaultError('invalid_input');
  } else if (policy.connector !== null) throw new VaultError('invalid_input');
}

/** All twenty core handlers. Auth and action groups are composed by the lead at the root. */
export function createBrokerCoreHandlers(): HandlersFor<BrokerCoreOp> {
  return {
    ...createCaptureHandlers(),
    ...createImportHandlers(),
    'vault.status': async (ctx) => {
      const viewer = await ctx.auth.viewer(ctx.caller, ctx.cookies);
      return { data: { mode: ctx.config.mode, reviewGate: ctx.config.reviewGate,
        testSecretsOnly: ctx.config.mode !== 'production' || ctx.config.reviewGate !== 'passed',
        broker: ctx.config.mode === 'off' ? 'disabled' : 'ok', audit: ctx.audit.status(),
        kms: { kind: ctx.components.kms.kind, productionGrade: ctx.components.kms.productionGrade },
        features: { ...ctx.config.features, spend: false, import: ctx.config.features.import && ctx.config.mode !== 'pre_review' },
        viewer: { passkeys: viewer.passkeys, recoveryCodesRemaining: viewer.recoveryCodesRemaining,
          vaultSession: viewer.session ? { sessionId: viewer.session.sessionId, expiresAt: viewer.session.expiresAt } : null } } };
    },
    'vault.items.list': async (ctx, { input }) => ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
      const page = await tx.items.list(input);
      const items = [];
      for (const item of page.rows) items.push(await itemView(ctx, tx, item));
      return { data: { items, nextCursor: page.nextCursor } };
    }),
    'vault.items.get': async (ctx, { params }) => ctx.store.transaction(memberScope(ctx.caller), async (tx) => ({
      data: await itemDetail(ctx, tx, await getItem(ctx, tx, params.itemId)),
    })),
    'vault.items.activity': async (ctx, { params, input }) => ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
      const item = await getItem(ctx, tx, params.itemId);
      const days = input.days ?? 7;
      const since = new Date(ctx.clock.now().getTime() - days * 86_400_000).toISOString();
      const events = await tx.audit.listForItem(item.id, since, 10_000);
      const groups = new Map<string, VaultOutput<'vault.items.activity'>['uses'][number]>();
      for (const event of events) {
        if (event.action !== 'fill.done' && event.action !== 'api.done') continue;
        const key = `${event.actor.kind}:${event.actor.memberId}:${event.actor.sessionId}`;
        let group = groups.get(key);
        if (!group) {
          group = { actor: event.actor, fills: 0, apiCalls: 0, origins: [], hosts: [], lastAt: event.at };
          groups.set(key, group);
        }
        if (event.action === 'fill.done') group.fills += 1;
        else group.apiCalls += 1;
        if (typeof event.params.origin === 'string' && !group.origins.includes(event.params.origin)) group.origins.push(event.params.origin);
        if (typeof event.params.host === 'string' && !group.hosts.includes(event.params.host)) group.hosts.push(event.params.host);
        if (event.at > group.lastAt) group.lastAt = event.at;
      }
      return { data: { itemId: item.id, windowDays: days, uses: [...groups.values()], recent: events.slice(0, 50).map(auditView) } };
    }),
    'vault.items.update': async (ctx, { params, input }) => {
      assertOwnerSession(ctx);
      scanMetadata(ctx, [input.name, input.username]);
      return ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        await getItem(ctx, tx, params.itemId, true);
        const item = await tx.items.update(params.itemId, input.expectedVersion,
          { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.username !== undefined ? { username: input.username } : {}) });
        await appendAudit(ctx, tx, 'item.updated', item.id, { version: item.version });
        return { data: await itemView(ctx, tx, item) };
      });
    },
    'vault.items.setProperties': async (ctx, { params, input }) => {
      assertOwnerSession(ctx, true);
      return ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const before = await getItem(ctx, tx, params.itemId, true);
        checkVersion(before, input.expectedVersion);
        if (before.type !== 'login' && ((input.addOrigins?.length ?? 0) > 0 || (input.removeOrigins?.length ?? 0) > 0)) throw VaultError.reason('wrong_item_type');
        const devMode = input.devMode ?? before.devMode;
        const addOrigins = input.addOrigins?.map((value) => normalize(ctx, value, devMode));
        const removeOrigins = input.removeOrigins?.map((value) => normalize(ctx, value, before.devMode));
        const remaining = [...before.origins.filter((value) => !removeOrigins?.includes(value)), ...(addOrigins ?? [])];
        for (const value of remaining) normalize(ctx, value, devMode);
        const item = await tx.items.setProperties(before.id, input.expectedVersion, {
          ...(addOrigins !== undefined ? { addOrigins } : {}), ...(removeOrigins !== undefined ? { removeOrigins } : {}),
          ...(input.devMode !== undefined ? { devMode: input.devMode } : {}),
        });
        await appendAudit(ctx, tx, 'item.properties_changed', item.id, { version: item.version, devMode: item.devMode });
        return { data: await itemDetail(ctx, tx, item) };
      });
    },
    'vault.items.delete': async (ctx, { params, input }) => {
      assertOwnerSession(ctx, true);
      const before = await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const item = await getItem(ctx, tx, params.itemId, true);
        if (item.state === 'tombstoned') throw new StoreStateError('tombstoned');
        checkVersion(item, input.expectedVersion);
        return item;
      });
      await ctx.components.deletionLedger.append({ itemId: before.id, spaceId: before.spaceId, ownerMemberId: before.ownerMemberId,
        tombstonedAt: ctx.clock.now().toISOString() });
      return ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const item = await tx.items.tombstone(before.id, input.expectedVersion, { ...ctx.actor, name: null });
        await appendAudit(ctx, tx, 'item.deleted', item.id, { version: item.version });
        return { data: { itemId: item.id, state: 'tombstoned', tombstonedAt: item.tombstonedAt! } };
      });
    },
    'vault.policies.set': async (ctx, { params, input }) => {
      assertOwnerSession(ctx, true);
      return ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const before = await getItem(ctx, tx, params.itemId, true);
        if (before.type !== 'api_key') throw VaultError.reason('wrong_item_type');
        checkVersion(before, input.expectedVersion);
        validatePolicy(ctx, input.policy);
        const { item } = await tx.policies.set(before.id, input.expectedVersion, input.policy, { ...ctx.actor, name: null });
        await appendAudit(ctx, tx, 'policy.set', item.id, { version: item.version });
        return { data: await itemDetail(ctx, tx, item) };
      });
    },
    'vault.grants.list': async (ctx, { params }) => {
      assertOwnerSession(ctx);
      return ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        await getItem(ctx, tx, params.itemId, true);
        return { data: { grants: (await tx.grants.listForItem(params.itemId)).map(grantView) } };
      });
    },
    'vault.grants.create': async (ctx, { params, input }) => {
      assertOwnerSession(ctx, true);
      if (!ctx.config.features.grants) throw new VaultError('forbidden');
      ctx.audit.assertHealthy();
      return ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const item = await getItem(ctx, tx, params.itemId, true);
        const constraints = { ...input.constraints };
        if (constraints.origins !== null) {
          constraints.origins = constraints.origins.map((value) => normalize(ctx, value, item.devMode));
          if (constraints.origins.some((value) => !item.origins.includes(value))) throw new VaultError('invalid_input');
        }
        if (constraints.hosts !== null) {
          scanMetadata(ctx, constraints.hosts);
          const policy = await tx.policies.get(item.id);
          if (!policy || constraints.hosts.some((value) => !policy.hosts.includes(value))) throw new VaultError('invalid_input');
        }
        if (input.expiresAt !== null && Date.parse(input.expiresAt) <= ctx.clock.now().getTime()) throw new VaultError('invalid_input');
        const grant = await tx.grants.create({ id: randomUUID(), itemId: item.id, granteeKind: input.grantee.kind,
          granteeId: input.grantee.id.toLowerCase(), constraints, expiresAt: input.expiresAt, createdBy: { ...ctx.actor, name: null } });
        await appendAudit(ctx, tx, 'grant.created', item.id, { granteeKind: grant.granteeKind });
        return { data: grantView(grant) };
      });
    },
    'vault.grants.revoke': async (ctx, { params }) => {
      assertOwnerSession(ctx);
      const before = await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const grant = await tx.grants.get(params.grantId);
        if (!grant) throw new StoreNotFoundError();
        return { grant, item: await getItem(ctx, tx, grant.itemId, true) };
      });
      // The ledger line comes first, so a database restore cannot revive the grant (test 17). A retry writes it again: the
      // earlier attempt may be the one whose append failed. A ledger fault never keeps a grantee's access alive, so the
      // revocation commits regardless and the fault is reported after it.
      let ledgerFault: unknown = null;
      try {
        await ctx.components.deletionLedger.appendRevocation({ kind: 'grant_revoked', grantId: before.grant.id, itemId: before.item.id,
          spaceId: before.item.spaceId, ownerMemberId: before.item.ownerMemberId, revokedAt: before.grant.revokedAt ?? ctx.clock.now().toISOString() });
      } catch (error) { ledgerFault = error; }
      const revoked = await ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        const current = await tx.grants.get(before.grant.id);
        if (!current) throw new StoreNotFoundError();
        await getItem(ctx, tx, current.itemId, true);
        const grant = await tx.grants.revoke(current.id, { ...ctx.actor, name: null });
        if (!current.revokedAt) await appendAudit(ctx, tx, 'grant.revoked', grant.itemId);
        return { data: grantView(grant) };
      });
      if (ledgerFault) throw ledgerFault;
      return revoked;
    },
    'vault.audit.list': async (ctx, { input }) => {
      assertOwnerSession(ctx);
      const verification = await ctx.audit.verifyIncremental();
      return ctx.store.transaction(memberScope(ctx.caller), async (tx) => {
        if (input.itemId) await getItem(ctx, tx, input.itemId);
        const page = await tx.audit.list(input);
        return { data: { events: page.rows.map(auditView), nextCursor: page.nextCursor,
          chain: { status: verification.status, headSeq: verification.checkedThroughSeq, headHash: verification.headHash } } };
      });
    },
    'vault.audit.verify': async (ctx) => {
      assertOwnerSession(ctx);
      const verified = await ctx.audit.verifyAll();
      const checkpoint = await ctx.store.transaction(memberScope(ctx.caller), (tx) => tx.audit.latestCheckpoint());
      return { data: { ...verified, checkpoint: checkpoint ? { seq: checkpoint.seq, at: checkpoint.at, sink: checkpoint.sink, anchored: checkpoint.anchored } : null } };
    },
  };
}
