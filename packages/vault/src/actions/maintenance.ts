import { SYSTEM_ACTOR, type OperationRecord, type VaultStore } from '../core-types.js';
import { auditKind } from './common.js';

/** Run before serving: an interrupted action must never silently execute twice. */
export async function markUnknownOperations(store: VaultStore): Promise<OperationRecord[]> {
  return store.transaction({ kind: 'system', purpose: 'reconcile' }, async (tx) => {
    const operations = await tx.operations.markInProgressUnknown();
    for (const operation of operations) {
      const item = await tx.items.get(operation.itemId);
      await tx.audit.append({ action: `${auditKind(operation.kind)}.unknown`, actor: SYSTEM_ACTOR,
        itemId: operation.itemId, subjectMemberId: item?.ownerMemberId ?? operation.memberId,
        spaceId: operation.spaceId, params: { operationId: operation.operationId, approvalId: operation.approvalId } });
    }
    return operations;
  });
}

/** Expiry and its audit record commit together; rerunning the sweep is a no-op. */
export async function sweepExpiredApprovals(store: VaultStore): Promise<number> {
  return store.transaction({ kind: 'system', purpose: 'expire' }, async (tx) => {
    const approvals = await tx.approvals.expireDue();
    for (const approval of approvals) {
      await tx.audit.append({ action: 'approval.expired', actor: SYSTEM_ACTOR,
        itemId: approval.itemId, subjectMemberId: approval.ownerMemberId, spaceId: approval.spaceId,
        params: { approvalId: approval.id, kind: approval.kind } });
    }
    return approvals.length;
  });
}
