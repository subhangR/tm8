import type { VaultAuditEventView, VaultGrantView, VaultItemDetail, VaultItemView, VaultPolicyView } from '@tm8/contract';
import {
  StoreNotFoundError, StoreVersionConflictError, VaultError,
  type AuditEventRecord, type AuditParam, type GrantRecord, type HandlerContext, type ItemRecord,
  type ItemMetadataFields, type VaultTx,
} from '../../core-types.js';
import type { ItemMetadata } from '../../capture/payload.js';

/** A handler re-checks owner presence even when called without the HTTP dispatcher. */
export function assertOwnerSession(ctx: HandlerContext, stepUp = false): void {
  if (ctx.caller.kind === 'agent') throw new VaultError('forbidden');
  if (!ctx.ownerSession || ctx.ownerSession.memberId !== ctx.caller.memberId
    || Date.parse(ctx.ownerSession.expiresAt) <= ctx.clock.now().getTime()) throw VaultError.reason('vault_session_required');
  if (stepUp && !ctx.stepUp) throw VaultError.reason('step_up_required');
}

export async function getItem(ctx: HandlerContext, tx: VaultTx, id: string, owner = false): Promise<ItemRecord> {
  const item = await tx.items.get(id);
  if (!item || (owner && item.ownerMemberId !== ctx.caller.memberId)) throw new StoreNotFoundError();
  return item;
}

export function checkVersion(item: ItemRecord, expected: number): void {
  if (item.version !== expected) throw new StoreVersionConflictError(item.version);
}

export function scanMetadata(ctx: HandlerContext, values: readonly (string | null | undefined)[]): void {
  for (const value of values) {
    if (value !== null && value !== undefined
      && (ctx.components.pasteDetector.scan(value).findings.length > 0 || ctx.components.canaries.matches(value))) throw VaultError.reason('secret_in_metadata');
  }
}

export function metadataFields(metadata: ItemMetadata): ItemMetadataFields {
  return { name: metadata.name, username: metadata.username ?? null, last4: metadata.last4 ?? null,
    expMonth: metadata.expMonth ?? null, expYear: metadata.expYear ?? null, connector: metadata.connector ?? null,
    hasTotp: metadata.hasTotp ?? false, hasNotes: metadata.hasNotes ?? false, fieldNames: metadata.fieldNames ?? [] };
}

export function scanItemMetadata(ctx: HandlerContext, metadata: ItemMetadata): void {
  scanMetadata(ctx, [metadata.name, metadata.username, metadata.origin, metadata.connector, ...(metadata.fieldNames ?? [])]);
}

export async function appendAudit(ctx: HandlerContext, tx: VaultTx, action: string, itemId: string | null = null,
  params: Record<string, AuditParam> = {}, subjectMemberId = ctx.caller.memberId): Promise<void> {
  // Never copy a request, actor display name, token, name or username into audit params.
  await tx.audit.append({ action, actor: { ...ctx.actor, name: null }, itemId, subjectMemberId, spaceId: ctx.caller.spaceId, params });
}

export function auditView(event: AuditEventRecord): VaultAuditEventView {
  return { seq: event.seq, at: event.at, action: event.action as VaultAuditEventView['action'], actor: event.actor,
    itemId: event.itemId, params: event.params, prevHash: event.prevHash, entryHash: event.entryHash };
}

export function grantView(grant: GrantRecord): VaultGrantView {
  return { id: grant.id, itemId: grant.itemId, grantee: { kind: grant.granteeKind, id: grant.granteeId, name: null },
    constraints: grant.constraints, expiresAt: grant.expiresAt, createdAt: grant.createdAt, createdBy: grant.createdBy, revokedAt: grant.revokedAt };
}

export async function itemView(ctx: HandlerContext, tx: VaultTx, item: ItemRecord): Promise<VaultItemView> {
  const owned = item.ownerMemberId === ctx.caller.memberId;
  const grants = owned ? [] : await tx.grants.activeForCaller(item.id);
  const origins = owned ? item.origins : item.origins.filter((origin) => grants.some((grant) => grant.constraints.origins === null || grant.constraints.origins.includes(origin)));
  // An explicit projection: adding a column to ItemRecord cannot add it to an outgoing object.
  return {
    id: item.id, version: item.version, type: item.type, name: item.name, ownerMemberId: item.ownerMemberId,
    access: owned ? 'owner' : 'grant', sharedBy: owned ? null : { memberId: item.ownerMemberId, name: null },
    state: item.state, exposureTier: item.exposureTier, origins, devMode: item.devMode, username: item.username,
    last4: item.last4, expMonth: item.expMonth, expYear: item.expYear, connector: item.connector,
    hasTotp: item.hasTotp, hasNotes: item.hasNotes, fieldNames: item.fieldNames, secretVersion: item.secretVersion,
    createdAt: item.createdAt, updatedAt: item.updatedAt, rotatedAt: item.rotatedAt,
  };
}

export async function itemDetail(ctx: HandlerContext, tx: VaultTx, item: ItemRecord): Promise<VaultItemDetail> {
  const row = await tx.policies.get(item.id);
  let policy: VaultPolicyView | null = row ? {
    version: row.version, mode: row.mode, connector: row.connector, hosts: row.hosts.slice(), methods: row.methods.slice(),
    pathPrefixes: row.pathPrefixes.slice(), maxRequestBytes: row.maxRequestBytes, maxResponseBytes: row.maxResponseBytes, injection: row.injection,
  } : null;
  const owned = item.ownerMemberId === ctx.caller.memberId;
  if (!owned && policy) {
    const grants = await tx.grants.activeForCaller(item.id);
    policy = { ...policy, hosts: policy.hosts.filter((host) => grants.some((grant) => grant.constraints.hosts === null || grant.constraints.hosts.includes(host))) };
    // The schema requires at least one host; with no usable host there is no usable policy.
    if (policy.hosts.length === 0) policy = null;
  }
  return { ...await itemView(ctx, tx, item), policy,
    pendingApprovals: owned ? await tx.approvals.countPending(item.id) : 0,
    activeGrants: owned ? await tx.grants.countActive(item.id) : 0 };
}

export async function assertPreReviewCapacity(ctx: HandlerContext, tx: VaultTx, added: number): Promise<void> {
  if (ctx.config.mode === 'pre_review' && await tx.items.countOwned() + added > ctx.config.preReview.maxItemsPerMember) throw VaultError.reason('pre_review_limit');
}
