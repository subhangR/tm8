import { createHash } from 'node:crypto';
import type { VaultOutput } from '@tm8/contract';
import {
  SYSTEM_ACTOR, VaultError, effectiveApprovalState, type ApprovalRecord, type AuditParam, type HandlerContext,
  type ItemRecord, type OperationRecord, type SpendCharge, type SpendRequestRecord, type VaultHandler,
} from '../core-types.js';
import { intentHash } from '../intent/hash.js';
import {
  approvalRequested, approvalView, audit, consumeApproval, hashIntent, liveGrants, liveItem, metadataText,
  refuseCanaryInput, replay, requestApproval, reserve, storedResult, transaction, type ActionIntent,
} from './common.js';

type SpendResult = VaultOutput<'vault.spend.execute'>;
type Refusal = Extract<SpendResult, { state: 'refused' }>['code'];

async function enabled(ctx: HandlerContext, params: Record<string, AuditParam>, itemId: string | null): Promise<void> {
  if (ctx.config.features.spend !== false && ctx.components.spend.kind !== 'disabled') return;
  await transaction(ctx, async (tx) => {
    const item = itemId === null ? null : await tx.items.get(itemId);
    await audit(tx, ctx, 'spend.refused', item, { ...params, code: 'spend_disabled' });
  });
  throw VaultError.reason('spend_disabled');
}

export const requestSpend: VaultHandler<'vault.spend.request'> = async (ctx, { params, input }) => {
  ctx.audit.assertHealthy();
  await enabled(ctx, {}, params.itemId);
  await refuseCanaryInput(ctx, input, params.itemId);
  const spend = { merchant: metadataText(ctx, input.merchant), amountMinor: input.amountMinor, currency: input.currency,
    itemSummary: metadataText(ctx, input.itemSummary), instrumentTier: 'tier1' as const };
  metadataText(ctx, input.purpose);
  const evidence = input.evidence ? (() => {
    const bytes = Buffer.from(input.evidence.dataBase64, 'base64');
    try { return { sha256: createHash('sha256').update(bytes).digest('hex'), width: input.evidence.width,
      height: input.evidence.height, maskedRegions: input.evidence.maskedRegions }; } finally { bytes.fill(0); }
  })() : null;
  const requested = await transaction(ctx, async (tx) => {
    const item = await liveItem(tx, params.itemId, 'card');
    await liveGrants(tx, ctx, item);
    const bound = { itemId: item.id, ...spend, evidenceHash: evidence?.sha256 ?? null,
      requesterMemberId: ctx.caller.memberId };
    const result = await requestApproval(tx, ctx, item, 'spend', bound, { spend, purpose: input.purpose });
    if (result.created) {
      await tx.spend.create({ approvalId: result.approval.id, itemId: item.id, ...spend, evidence });
      await audit(tx, ctx, 'spend.requested', item, { approvalId: result.approval.id, amountMinor: spend.amountMinor,
        currency: spend.currency, intentHash: result.approval.intentHash });
    }
    return { ...result, item, data: await approvalView(tx, result.approval) };
  });
  if (requested.created) approvalRequested(ctx, requested.item, requested.approval);
  return { data: requested.data };
};

function boundSpend(approval: ApprovalRecord, request: SpendRequestRecord): boolean {
  const bound = approval.boundParams;
  return approval.kind === 'spend' && approval.oneUse && approval.spend !== null
    && bound.kind === 'spend' && bound.itemId === request.itemId && bound.requesterMemberId === approval.requesterMemberId
    && bound.expiresAt === approval.expiresAt && approval.intentHash === intentHash('spend', bound)
    && bound.amountMinor === request.amountMinor && bound.currency === request.currency && bound.merchant === request.merchant
    && bound.itemSummary === request.itemSummary && bound.instrumentTier === request.instrumentTier
    && bound.evidenceHash === (request.evidence?.sha256 ?? null)
    && approval.spend.amountMinor === request.amountMinor && approval.spend.currency === request.currency
    && approval.spend.merchant === request.merchant && approval.spend.itemSummary === request.itemSummary;
}

function chargeResult(operationId: string, approvalId: string, request: SpendRequestRecord, charge: SpendCharge): SpendResult {
  if (charge.state === 'declined') return { state: 'refused', operationId, approvalId, code: 'processor_declined' };
  if (charge.state === 'unknown' || charge.amountMinor !== request.amountMinor || charge.currency !== request.currency
    || !/^[A-Za-z0-9_.:-]{1,200}$/.test(charge.processorRef)) return { state: 'unknown', operationId, approvalId };
  return { state: 'done', operationId, approvalId, merchant: request.merchant, amountMinor: request.amountMinor,
    currency: request.currency, processorRef: charge.processorRef };
}

/** Lookup is the only processor call allowed for an approval with an unknown prior attempt. */
async function reconcile(ctx: HandlerContext, approval: ApprovalRecord): Promise<boolean> {
  const unknown = await ctx.store.transaction({ kind: 'system', purpose: 'reconcile' }, async (tx) =>
    (await tx.operations.listUnknown('spend')).filter((operation) => operation.approvalId === approval.id
      && operation.memberId === ctx.caller.memberId && operation.spaceId === ctx.caller.spaceId));
  let unresolved = false;
  for (const operation of unknown) {
    const request = await transaction(ctx, (tx) => tx.spend.getByApproval(approval.id));
    if (!request || !boundSpend(approval, request)) { unresolved = true; continue; }
    let charge: Awaited<ReturnType<HandlerContext['components']['spend']['lookup']>>;
    try { charge = await ctx.components.spend.lookup(operation.operationId); } catch { charge = { state: 'unknown' }; }
    const result: SpendResult = charge.state === 'not_found'
      ? { state: 'refused', operationId: operation.operationId, approvalId: approval.id, code: 'processor_declined' }
      : chargeResult(operation.operationId, approval.id, request, charge);
    if (result.state === 'unknown') { unresolved = true; continue; }
    await ctx.store.transaction({ kind: 'system', purpose: 'reconcile' }, async (tx) => {
      const stillUnknown = (await tx.operations.listUnknown('spend')).some((row) =>
        row.memberId === operation.memberId && row.operationId === operation.operationId);
      if (!stillUnknown) return;
      if (result.state === 'done') {
        const current = await tx.spend.getByApproval(approval.id);
        if (!current) throw VaultError.reason('vault_unavailable');
        if (current.executedAt === null) await tx.spend.markExecuted(approval.id, result.processorRef);
      }
      await tx.operations.resolveUnknown(operation.memberId, operation.operationId, { state: result.state, result });
      await tx.audit.append({ action: 'spend.reconciled', actor: SYSTEM_ACTOR, itemId: operation.itemId,
        subjectMemberId: approval.ownerMemberId, spaceId: approval.spaceId,
        params: { operationId: operation.operationId, approvalId: approval.id, state: result.state } });
    });
  }
  return unresolved;
}

export const executeSpend: VaultHandler<'vault.spend.execute'> = async (ctx, { params, input }) => {
  ctx.audit.assertHealthy();
  await enabled(ctx, { approvalId: params.approvalId, operationId: input.operationId }, null);
  await refuseCanaryInput(ctx, input, null);
  const hash = hashIntent({ action: 'spend', approvalId: params.approvalId });
  const initial = await transaction(ctx, async (tx) => {
    const previous = await tx.operations.get(input.operationId);
    if (previous) {
      replay(previous, { kind: 'spend', itemId: previous.itemId, operationId: input.operationId, intentHash: hash });
      if (previous.approvalId !== params.approvalId) throw VaultError.reason('operation_id_reused');
      if (previous.state !== 'unknown') return { result: storedResult('vault.spend.execute', previous) };
    }
    const approval = await tx.approvals.get(params.approvalId);
    if (!approval || approval.requesterMemberId !== ctx.caller.memberId) throw new VaultError('not_found');
    return { approval };
  });
  if ('result' in initial && initial.result) return { data: initial.result };
  const approval = initial.approval!;
  // Reconcile before checking consumed state or reserving any new execution.
  const unresolved = await reconcile(ctx, approval);
  const prepared = await transaction(ctx, async (tx) => {
    const previous = await tx.operations.get(input.operationId);
    const intent: ActionIntent = { kind: 'spend', itemId: approval.itemId, operationId: input.operationId, intentHash: hash };
    if (previous) return { result: storedResult('vault.spend.execute', replay(previous, intent)) };
    if (unresolved) throw VaultError.reason('operation_in_progress');
    const current = await tx.approvals.get(params.approvalId);
    if (!current || current.requesterMemberId !== ctx.caller.memberId) throw new VaultError('not_found');
    const item = await liveItem(tx, current.itemId, 'card');
    await liveGrants(tx, ctx, item);
    const request = await tx.spend.getByApproval(current.id);
    let code: Refusal | null = !ctx.components.spend.configured ? 'processor_not_configured' : null;
    const state = effectiveApprovalState(current, tx.now);
    if (state === 'consumed' || current.consumedAt !== null || request?.executedAt !== null && request?.executedAt !== undefined) code = 'approval_consumed';
    else if (state !== 'approved' || current.kind !== 'spend' || !current.oneUse) code = 'approval_not_approved';
    else if (!request || !boundSpend(current, request)) code = 'amount_mismatch';
    const already = await reserve(tx, ctx, item, intent, { approvalId: current.id,
      intentHash: hash }, current.id);
    if (already) return { result: storedResult('vault.spend.execute', already) };
    if (code !== null) {
      const result: SpendResult = { state: 'refused', operationId: input.operationId, approvalId: current.id, code };
      await tx.operations.complete(input.operationId, { state: 'refused', result });
      await audit(tx, ctx, 'spend.refused', item, { operationId: input.operationId, approvalId: current.id, code });
      return { result };
    }
    await consumeApproval(tx, ctx, item, current, input.operationId);
    return { item, request: request! };
  });
  if ('result' in prepared && prepared.result) return { data: prepared.result };
  const { item, request } = prepared as { item: ItemRecord; request: SpendRequestRecord };
  let charge: SpendCharge;
  try {
    charge = await ctx.components.spend.charge({ idempotencyKey: input.operationId, merchant: request.merchant,
      amountMinor: request.amountMinor, currency: request.currency, signal: ctx.signal });
  } catch { charge = { state: 'unknown' }; }
  const result = chargeResult(input.operationId, params.approvalId, request, charge);
  await transaction(ctx, async (tx) => {
    if (result.state === 'done') await tx.spend.markExecuted(params.approvalId, result.processorRef);
    await tx.operations.complete(input.operationId, { state: result.state, result });
    await audit(tx, ctx, result.state === 'done' ? 'spend.executed' : result.state === 'unknown' ? 'spend.unknown' : 'spend.refused', item,
      { operationId: input.operationId, approvalId: params.approvalId,
        ...(result.state === 'refused' ? { code: result.code } : { amountMinor: request.amountMinor, currency: request.currency }) });
  });
  return { data: result };
};
