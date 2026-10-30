/**
 * Bridges L (BRIDGE-ENTITY-DESIGN D26, D68; migration 406): a bridge loop's
 * authority. Its worker posts as the teammate and acts on its owner's
 * (`armed_by`) authority. What arming grants needs no approval per run:
 * creating and editing stories, docs, tasks and labels, and posting to
 * groups. What cannot be undone stays approval-gated: the operations below.
 *
 * The gate is an {@link OperationGuard} on the registry, the one point every
 * operation passes through. It applies only to a caller bound to a work
 * session (an agent bearer). For a session under a loop with bridge targets
 * (itself fired by the loop, or spawned under one) it raises a `decide`
 * attention request on the loop, assigned to the owner, and refuses the
 * operation `forbidden` / `approval_required`. The request is in tm8 and
 * nothing is posted in any group (v2 §2.2). Every other session passes.
 */
import { CollabError, type OperationName } from '@tm8/contract';
import { claimsFor } from '../facade/context.js';
import type { FacadeDeps } from '../facade/deps.js';
import type { OperationGuard } from '../facade/registry.js';

/**
 * Delete, merge a PR, change members, bridges or permissions (D26). Deploy and
 * over-budget spend have no operation of their own yet (D68): the gate covers
 * them when they do.
 */
export const LOOP_APPROVAL_GATED_OPERATIONS: ReadonlySet<OperationName> = new Set<OperationName>([
  // delete
  'entities.delete', 'messages.delete', 'workspace.delete', 'containers.destroy', 'savedViews.delete',
  'credentials.delete', 'credentials.space.delete', 'credentials.serviceKeys.delete',
  'mcp.servers.delete', 'serverConnections.delete', 'servers.remove',
  'spaces.workflows.delete', 'spaces.taskWorkflows.delete', 'spaces.taskAxes.delete',
  'messages.attachments.remove',
  'forms.questions.remove', 'styles.remove', 'styles.personal.delete', 'projects.unlink',
  // merging a PR
  'tracking.pr.merge',
  // members
  'spaces.members.updateRole', 'spaces.members.remove', 'spaces.invites.create', 'spaces.invites.revoke',
  'spaces.members.spacePassword.reset', 'spaces.members.spacePassword.lock', 'accounts.disable',
  // bridges (every mutating op but a session's own handle and wake level, D23/D34)
  'bridges.create', 'bridges.update', 'bridges.retarget', 'bridges.pause', 'bridges.resume', 'bridges.remove',
  // permissions (the other spaceLinks.*, mcp.tokens.* and credential sharing ops are humanOnly, so already refused to a session)
  'spaceLinks.remove', 'spaceLinks.inbound.grant', 'spaceLinks.inbound.revoke',
  'node.pathGrants.create', 'node.pathGrants.revoke',
  'mcp.credentials.revoke', 'mcp.credentials.revokeAll', 'auth.sessions.revoke',
]);

interface ApprovalRequest { requestId: string; created: boolean; loopId: string; ownerMemberId: string | null }

export function loopAuthorityGuard(deps: Pick<FacadeDeps, 'db' | 'owner'>): OperationGuard {
  return {
    applies: (name, ctx) => LOOP_APPROVAL_GATED_OPERATIONS.has(name) && typeof ctx.identity.workSessionId === 'string',
    async check(name, ctx) {
      const sessionId = ctx.identity.workSessionId!;
      const target = Object.values(ctx.params).join(' ');
      const request = await deps.db.tx(claimsFor(await deps.owner(), ctx), q =>
        q.rpc<ApprovalRequest | null>('loop_request_approval', [sessionId, name, target === '' ? name : `${name} ${target}`]));
      if (request === null) return;
      throw new CollabError('forbidden',
        `${name} needs the loop owner's approval: a request is waiting for them in tm8 (attention ${request.requestId}). Do not ask for it in a group.`,
        { details: { reason: 'approval_required', operation: name, loopId: request.loopId, requestId: request.requestId } });
    },
  };
}
