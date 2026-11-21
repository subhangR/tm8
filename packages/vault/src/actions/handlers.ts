import type { AgentActionOp, HandlersFor } from '../core-types.js';
import { callApi } from './api.js';
import { decideApproval, getApproval, getOperation, listApprovals, requestOrigin } from './approvals.js';
import { fill } from './fill.js';
import { executeSpend, requestSpend } from './spend.js';

export { markUnknownOperations, sweepExpiredApprovals } from './maintenance.js';
export { disabledSpendProcessor } from './disabled-spend.js';

export function createAgentActionHandlers(): HandlersFor<AgentActionOp> {
  return {
    'vault.fill': fill,
    'vault.callApi': callApi,
    'vault.origins.requestAdd': requestOrigin,
    'vault.spend.request': requestSpend,
    'vault.spend.execute': executeSpend,
    'vault.operations.get': getOperation,
    'vault.approvals.list': listApprovals,
    'vault.approvals.get': getApproval,
    'vault.approvals.decide': decideApproval,
  };
}
