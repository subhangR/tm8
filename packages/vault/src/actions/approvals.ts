import { VAULT_OUTPUT_SCHEMAS } from '@tm8/contract';
import { VaultError, effectiveApprovalState, type ApprovalRecord, type HandlerContext, type VaultHandler, type VaultTx } from '../core-types.js';
import { intentHash } from '../intent/hash.js';
import {
  actionActor, approvalRequested, approvalView, audit, exactOrigin, liveGrants, liveItem,
  lookalike, metadataText, originParams, ownerSession, refuseCanaryInput, requestApproval, storedResult, transaction,
} from './common.js';

export const requestOrigin: VaultHandler<'vault.origins.requestAdd'> = async (ctx, { params, input }) => {
  ctx.audit.assertHealthy();
  await refuseCanaryInput(ctx, input, params.itemId);
  metadataText(ctx, input.purpose);
  const requested = await transaction(ctx, async (tx) => {
    const item = await liveItem(tx, params.itemId, 'login');
    await liveGrants(tx, ctx, item);
    const origin = exactOrigin(input.origin, item);
    const findings = lookalike(origin, item);
    if (ctx.caller.kind === 'agent' && findings.length > 0) {
      await audit(tx, ctx, 'value_request.refused', item, { reason: 'origin_refused' });
      return { refused: true as const };
    }
    const result = await requestApproval(tx, ctx, item, 'new_origin', originParams(ctx, item.id, origin),
      { purpose: input.purpose, lookalike: findings });
    return { ...result, item, data: await approvalView(tx, result.approval) };
  });
  if ('refused' in requested) throw VaultError.reason('origin_refused');
  if (requested.created) approvalRequested(ctx, requested.item, requested.approval);
  return { data: requested.data };
};

export const listApprovals: VaultHandler<'vault.approvals.list'> = async (ctx, { input }) => ({
  data: await transaction(ctx, async (tx) => {
    const page = await tx.approvals.list(input);
    return { approvals: await Promise.all(page.rows.map((approval) => approvalView(tx, approval))), nextCursor: page.nextCursor };
  }),
});

export const getApproval: VaultHandler<'vault.approvals.get'> = async (ctx, { params }) => ({
  data: await transaction(ctx, async (tx) => {
    const approval = await tx.approvals.get(params.approvalId);
    if (!approval) throw new VaultError('not_found');
    return approvalView(tx, approval);
  }),
});

async function pendingOwned(tx: VaultTx, ctx: HandlerContext, approvalId: string, hash: string): Promise<ApprovalRecord> {
  const approval = await tx.approvals.get(approvalId);
  if (!approval || approval.ownerMemberId !== ctx.caller.memberId) throw new VaultError('not_found');
  if (effectiveApprovalState(approval, tx.now) !== 'pending') throw VaultError.reason('approval_not_pending');
  const bound = approval.boundParams;
  if (approval.intentHash !== hash || approval.intentHash !== intentHash(approval.kind, bound)
    || bound.kind !== approval.kind || bound.itemId !== approval.itemId
    || bound.requesterMemberId !== approval.requesterMemberId || bound.expiresAt !== approval.expiresAt) {
    throw VaultError.reason('approval_hash_mismatch');
  }
  return approval;
}

export const decideApproval: VaultHandler<'vault.approvals.decide'> = async (ctx, { params, input }) => {
  ctx.audit.assertHealthy();
  const session = ownerSession(ctx);
  await refuseCanaryInput(ctx, input, null);
  const validate = async (tx: VaultTx) => {
    const approval = await pendingOwned(tx, ctx, params.approvalId, input.approvalIntentHash);
    if (input.standing === true && (input.decision !== 'approve' || approval.kind !== 'new_origin')) {
      throw new VaultError('invalid_input');
    }
    return approval;
  };
  // Step-up owns its transaction. Never nest it inside the decision transaction.
  if (input.decision === 'approve') {
    await transaction(ctx, validate);
    await ctx.auth.verifyStepUp(ctx.caller, session, input.stepUp,
      { action: 'vault.approvals.decide', pathParams: params, body: input });
  }
  const data = await transaction(ctx, async (tx) => {
    const current = await validate(tx);
    const item = await liveItem(tx, current.itemId);
    const approval = await tx.approvals.decide(current.id, { state: input.decision === 'approve' ? 'approved' : 'denied',
      standing: input.standing === true, decidedBy: actionActor(ctx) });
    if (approval.standing) {
      const origin = approval.boundParams.origin;
      if (typeof origin !== 'string' || exactOrigin(origin, item) !== origin) throw VaultError.reason('origin_refused');
      await tx.items.addOrigin(item.id, origin);
      await audit(tx, ctx, 'item.properties_changed', item, { approvalId: approval.id, origin });
    }
    await audit(tx, ctx, input.decision === 'approve' ? 'approval.approved' : 'approval.denied', item,
      { approvalId: approval.id, intentHash: approval.intentHash, standing: approval.standing });
    return approvalView(tx, approval);
  });
  return { data };
};

export const getOperation: VaultHandler<'vault.operations.get'> = async (ctx, { params }) => ({
  data: await transaction(ctx, async (tx) => {
    const operation = await tx.operations.get(params.operationId);
    if (!operation || operation.memberId !== ctx.caller.memberId || operation.spaceId !== ctx.caller.spaceId) {
      throw new VaultError('not_found');
    }
    const result = operation.state === 'in_progress' ? null : operation.kind === 'fill'
      ? storedResult('vault.fill', operation) : operation.kind === 'call_api'
        ? storedResult('vault.callApi', operation) : storedResult('vault.spend.execute', operation);
    const view = VAULT_OUTPUT_SCHEMAS['vault.operations.get'].safeParse({ operationId: operation.operationId,
      itemId: operation.itemId, kind: operation.kind, state: operation.state, result,
      createdAt: operation.createdAt, completedAt: operation.completedAt });
    if (!view.success) throw VaultError.reason('vault_unavailable');
    return view.data;
  }),
});
