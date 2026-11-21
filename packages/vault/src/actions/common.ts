import { randomUUID } from 'node:crypto';
import { VAULT_OUTPUT_SCHEMAS, type VaultApprovalView, type VaultOutput } from '@tm8/contract';
import {
  AuditUnavailableError, StoreNotFoundError, StoreStateError, StoreUnavailableError, VaultError,
  effectiveApprovalState, memberScope,
  type ActorRecord, type ApprovalKind, type ApprovalRecord, type AuditParam, type GrantRecord,
  type HandlerContext, type ItemRecord, type NewApproval, type OperationKind, type OperationRecord,
  type StoreScope, type VaultAlertKind, type VaultTx,
} from '../core-types.js';
import { intentHash } from '../intent/hash.js';
import { normalizeOrigin, OriginRefusal } from '../origin/normalize.js';
import { assessLookalike } from '../origin/lookalike.js';

export const APPROVAL_TTL_MS = 15 * 60_000;

/** Attribution never copies a display name into the audit trail. */
export function actionActor(ctx: HandlerContext): ActorRecord {
  return { kind: ctx.caller.kind, memberId: ctx.caller.memberId, sessionId: ctx.caller.sessionId, name: null };
}

export async function transaction<T>(ctx: HandlerContext, work: (tx: VaultTx) => Promise<T>): Promise<T> {
  return storeTransaction(ctx, memberScope(ctx.caller), work);
}

export async function storeTransaction<T>(ctx: HandlerContext, scope: StoreScope, work: (tx: VaultTx) => Promise<T>): Promise<T> {
  try {
    return await ctx.store.transaction(scope, work);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    if (error instanceof AuditUnavailableError) {
      ctx.audit.reportAppendFailure();
      throw VaultError.reason('audit_unavailable');
    }
    if (error instanceof StoreUnavailableError) throw VaultError.reason('vault_unavailable');
    if (error instanceof StoreNotFoundError) throw new VaultError('not_found');
    if (error instanceof StoreStateError) throw new VaultError('conflict');
    // Database errors and validation errors can contain request data.
    throw VaultError.reason('vault_unavailable');
  }
}

export async function liveItem(tx: VaultTx, itemId: string, type?: ItemRecord['type']): Promise<ItemRecord> {
  const item = await tx.items.get(itemId);
  if (!item || item.state === 'tombstoned') throw new VaultError('not_found');
  if (item.state === 'blocked_until_rotated') throw VaultError.reason('item_blocked');
  if (type !== undefined && item.type !== type) throw VaultError.reason('wrong_item_type');
  return item;
}

/** A fresh read at the same transaction boundary as reservation, never cached. */
export async function liveGrants(tx: VaultTx, ctx: HandlerContext, item: ItemRecord): Promise<GrantRecord[] | null> {
  if (item.ownerMemberId === ctx.caller.memberId) return null;
  const grants = (await tx.grants.activeForCaller(item.id)).filter((grant) =>
    grant.itemId === item.id && grant.spaceId === ctx.caller.spaceId && grant.revokedAt === null
    && (grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.parse(tx.now))
    && ((grant.granteeKind === 'member' && grant.granteeId === ctx.caller.memberId)
      || (grant.granteeKind === 'space' && grant.granteeId === ctx.caller.spaceId)));
  if (grants.length === 0) throw new VaultError('not_found');
  return grants;
}

export function hashIntent(params: Record<string, unknown>): string {
  try { return intentHash('use', params); } catch { throw new VaultError('invalid_input'); }
}

export function exactOrigin(input: string, item: ItemRecord): string {
  try { return normalizeOrigin(input, { devMode: item.devMode }).origin; } catch (error) {
    if (error instanceof OriginRefusal) throw VaultError.reason('origin_refused');
    throw new VaultError('invalid_input');
  }
}

export async function audit(
  tx: VaultTx, ctx: HandlerContext, action: string, item: ItemRecord | null, params: Record<string, AuditParam>,
): Promise<void> {
  await tx.audit.append({ action, actor: actionActor(ctx), itemId: item?.id ?? null,
    subjectMemberId: item?.ownerMemberId ?? ctx.caller.memberId, spaceId: ctx.caller.spaceId, params });
}

export function alert(ctx: HandlerContext, kind: VaultAlertKind, item: ItemRecord | null, params: Record<string, AuditParam>): void {
  ctx.components.alerts.raise({ kind, memberId: item?.ownerMemberId ?? ctx.caller.memberId,
    spaceId: ctx.caller.spaceId, itemId: item?.id ?? null, params, at: ctx.clock.now().toISOString() });
}

function inputStrings(value: unknown, visit: (text: string) => boolean, depth = 0): boolean {
  if (depth > 32) throw new VaultError('invalid_input');
  if (typeof value === 'string') return visit(value);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => visit(key) || inputStrings(child, visit, depth + 1));
}

/** Canary values are never echoed, even as an origin, hash input error or purpose. */
export async function refuseCanaryInput(ctx: HandlerContext, input: unknown, itemId: string | null): Promise<void> {
  if (!inputStrings(input, (text) => ctx.components.canaries.matches(text))) return;
  const item = await transaction(ctx, async (tx) => {
    const visible = itemId === null ? null : await tx.items.get(itemId);
    await audit(tx, ctx, 'canary.detected', visible, { source: 'action_input' });
    return visible;
  });
  alert(ctx, 'canary_detected', item, { source: 'action_input' });
  throw VaultError.reason('value_request_refused');
}

export function metadataText(ctx: HandlerContext, value: string): string {
  if (ctx.components.pasteDetector.scan(value).findings.some((finding) => finding.confidence === 'high')) {
    throw VaultError.reason('secret_in_metadata');
  }
  return value;
}

export function originParams(ctx: HandlerContext, itemId: string, origin: string): Record<string, AuditParam> {
  return { itemId, origin, requesterMemberId: ctx.caller.memberId };
}

export function useParams(ctx: HandlerContext, itemId: string, action: string, actionIntentHash: string): Record<string, AuditParam> {
  return { itemId, action, actionIntentHash, requesterMemberId: ctx.caller.memberId };
}

export function lookalike(origin: string, item: ItemRecord): ApprovalRecord['lookalike'] {
  return assessLookalike(origin, item.origins).map((finding) => ({ kind: finding.kind, similarTo: finding.similarTo ?? null }));
}

export async function requestApproval(
  tx: VaultTx, ctx: HandlerContext, item: ItemRecord, kind: ApprovalKind,
  boundParams: Record<string, AuditParam>, options: Partial<Pick<NewApproval, 'purpose' | 'lookalike' | 'spend' | 'operationId'>> = {},
): Promise<{ approval: ApprovalRecord; created: boolean }> {
  const pending = await findMatchingApproval(tx, ctx.caller.memberId, item.id, kind, boundParams, 'pending');
  if (pending) return { approval: pending, created: false };
  const expiresAt = new Date(Date.parse(tx.now) + APPROVAL_TTL_MS).toISOString();
  const bound = { ...boundParams, kind, itemId: item.id, requesterMemberId: ctx.caller.memberId, expiresAt };
  const hash = intentHash(kind, bound);
  const approval = await tx.approvals.create({ id: randomUUID(), itemId: item.id, kind, oneUse: true,
    intentHash: hash, boundParams: bound, requestedBy: actionActor(ctx), purpose: options.purpose ?? null,
    lookalike: options.lookalike ?? [], spend: options.spend ?? null, operationId: options.operationId ?? null,
    expiresAt });
  await audit(tx, ctx, 'approval.requested', item, { approvalId: approval.id, kind, intentHash: hash });
  return { approval, created: true };
}

export function approvalRequested(ctx: HandlerContext, item: ItemRecord, approval: ApprovalRecord): void {
  alert(ctx, 'approval_requested', item, { approvalId: approval.id, kind: approval.kind });
}

/** Expiry is signed but a later caller does not know it. Discover it, then use the exact repo lookup. */
async function findMatchingApproval(tx: VaultTx, requesterMemberId: string, itemId: string, kind: ApprovalKind,
  params: Record<string, AuditParam>, state: 'pending' | 'approved'): Promise<ApprovalRecord | null> {
  let cursor: string | undefined;
  let scanned = 0;
  do {
    const page = await tx.approvals.list({ itemId, state, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    for (const candidate of page.rows) {
      if (++scanned > 1000) throw new VaultError('rate_limited');
      if (candidate.kind !== kind || candidate.requesterMemberId !== requesterMemberId
        || (state === 'approved' && (!candidate.oneUse || candidate.consumedAt !== null))) continue;
      const bound = { ...params, kind, itemId, requesterMemberId, expiresAt: candidate.expiresAt };
      const hash = intentHash(kind, bound);
      if (candidate.intentHash !== hash) continue;
      if (candidate.boundParams.expiresAt !== candidate.expiresAt || intentHash(kind, candidate.boundParams) !== hash) {
        throw VaultError.reason('approval_hash_mismatch');
      }
      return state === 'pending' ? tx.approvals.findPending(itemId, kind, hash) : tx.approvals.findUsable(itemId, kind, hash);
    }
    if (scanned >= 1000) throw new VaultError('rate_limited');
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return null;
}

export async function usableApproval(tx: VaultTx, itemId: string, kind: ApprovalKind, boundParams: Record<string, AuditParam>): Promise<ApprovalRecord | null> {
  const requester = boundParams.requesterMemberId;
  if (typeof requester !== 'string') throw new VaultError('invariant_violation');
  return findMatchingApproval(tx, requester, itemId, kind, boundParams, 'approved');
}

export async function consumeApproval(tx: VaultTx, ctx: HandlerContext, item: ItemRecord, approval: ApprovalRecord, operationId: string): Promise<void> {
  try { await tx.approvals.consume(approval.id, operationId); } catch (error) {
    if (error instanceof StoreStateError) throw VaultError.reason('approval_not_pending');
    throw error;
  }
  await audit(tx, ctx, 'approval.consumed', item, { approvalId: approval.id, operationId });
}

export interface ActionIntent {
  operationId: string;
  kind: OperationKind;
  itemId: string;
  intentHash: string;
}

export function replay(operation: OperationRecord, intent: ActionIntent, spaceId: string): OperationRecord {
  if (operation.spaceId !== spaceId) throw new VaultError('not_found');
  if (operation.intentHash !== intent.intentHash || operation.kind !== intent.kind || operation.itemId !== intent.itemId) {
    throw VaultError.reason('operation_id_reused');
  }
  if (operation.state === 'in_progress') throw VaultError.reason('operation_in_progress');
  return operation;
}

export async function reserve(tx: VaultTx, ctx: HandlerContext, item: ItemRecord, intent: ActionIntent,
  params: Record<string, AuditParam>, approvalId: string | null): Promise<OperationRecord | null> {
  const reserved = await tx.operations.reserve({ ...intent, actor: actionActor(ctx), approvalId });
  if (!reserved.created) return replay(reserved.operation, intent, ctx.caller.spaceId);
  await audit(tx, ctx, `${auditKind(intent.kind)}.started`, item, { operationId: intent.operationId,
    intentHash: intent.intentHash, ...params });
  return null;
}

export function auditKind(kind: OperationKind): 'fill' | 'api' | 'spend' {
  return kind === 'call_api' ? 'api' : kind;
}

export function storedResult<Op extends 'vault.fill' | 'vault.callApi' | 'vault.spend.execute'>(op: Op, operation: OperationRecord): VaultOutput<Op> {
  const unknown = operation.kind === 'spend'
    ? { state: 'unknown', operationId: operation.operationId, approvalId: operation.approvalId }
    : { state: 'unknown', operationId: operation.operationId, itemId: operation.itemId };
  const result = VAULT_OUTPUT_SCHEMAS[op].safeParse(operation.result ?? unknown);
  if (!result.success) throw VaultError.reason('vault_unavailable');
  return result.data as VaultOutput<Op>;
}

export async function approvalView(tx: VaultTx, approval: ApprovalRecord): Promise<VaultApprovalView> {
  // Approvals remain visible to their requester after a grant is revoked.
  const item = await tx.items.get(approval.itemId);
  return { id: approval.id, kind: approval.kind, state: effectiveApprovalState(approval, tx.now), oneUse: approval.oneUse,
    intentHash: approval.intentHash, itemId: approval.itemId, itemName: item?.name ?? '', boundParams: approval.boundParams,
    requestedBy: approval.requestedBy, purpose: approval.purpose, lookalike: approval.lookalike, spend: approval.spend,
    createdAt: approval.createdAt, expiresAt: approval.expiresAt, decidedAt: approval.decidedAt,
    decidedBy: approval.decidedBy, consumedAt: approval.consumedAt };
}

export function ownerSession(ctx: HandlerContext): NonNullable<HandlerContext['ownerSession']> {
  const session = ctx.ownerSession;
  if (ctx.caller.kind !== 'member' || !session || session.memberId !== ctx.caller.memberId
    || Date.parse(session.expiresAt) <= ctx.clock.now().getTime()) throw VaultError.reason('vault_session_required');
  return session;
}
