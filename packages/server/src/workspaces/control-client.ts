import { createHmac, randomUUID } from 'node:crypto';
import { CollabError } from '@tm8/contract';
import { createDb } from '../db/client.js';
import type { Db } from '../db/types.js';
import type { RequestIdentity } from '../http/types.js';
import { formatToken, generateSecret, hashToken } from '../identity/crypto.js';
import type { WorkspaceConfiguration } from './config.js';

interface Handoff {
  session_id: string; account_id: string; identity_id: string; email: string;
  workspace_id: string; operation_id: string; leaseSeconds: number;
  invitationIds?: string[];
}
interface LeaseLink { central_session_id: string; workspace_id: string; lease_until: string }
export class NodeControlClient {
  private readonly enrollment: Db;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  constructor(readonly config: WorkspaceConfiguration, readonly db: Db) {
    if (!config.controlOrigin || !config.machineCredential || !config.enrollmentDatabaseUrl) {
      throw new Error('Distributed nodes require TM8_MACHINE_CREDENTIAL and TM8_NODE_CONTROL_DATABASE_URL');
    }
    this.enrollment = createDb(config.enrollmentDatabaseUrl, { role: 'tm8_node_enrollment', max: 3 });
  }
  private async call<T>(route: string, input: Record<string, unknown>): Promise<T> {
    try {
      const response = await fetch(`${this.config.controlOrigin}${route}`, {
        method: 'POST', headers: { authorization: `Bearer ${this.config.machineCredential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, machineId: this.config.machineId }), signal: AbortSignal.timeout(4000), redirect: 'error',
      });
      if (response.status === 401 || response.status === 403) throw new CollabError('unauthenticated', 'Central authorization has expired or been revoked');
      if (response.status === 409 || response.status === 400) {
        const result = await response.json() as { error?: { code?: string } };
        throw new CollabError('conflict', result.error?.code === 'cross_machine_sharing_unsupported'
          ? 'Cross-machine space sharing is not supported; invite a user assigned to this machine'
          : 'Central configuration conflicts with this request');
      }
      if (!response.ok) throw new Error('Control service refused request');
      return (await response.json() as { data: T }).data;
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw new CollabError('upstream_unavailable', 'Central authentication is unavailable');
    }
  }
  async start(): Promise<void> {
    await this.heartbeat();
    this.heartbeatTimer = setInterval(() => { void this.heartbeat().catch(() => undefined); }, 20000);
    this.heartbeatTimer.unref();
  }
  private async heartbeat(): Promise<void> {
    const machine = await this.call<{ capacity: number }>('/node/heartbeat', {});
    await this.enrollment.rpc({}, 'configure_enrolled_workspace_limits', [this.config.machineId, machine.capacity, JSON.stringify(this.config.limits)]);
    this.config.capabilities.maxUsersPerMachine = machine.capacity;
  }
  async redeem(code: string): Promise<{ token: string; expiresAt: string; workspaceId: string }> {
    const handoff = await this.call<Handoff>('/node/redeem', { code });
    const sessionId = randomUUID(), secret = generateSecret();
    await this.enrollment.rpc({}, 'import_control_session', [handoff.account_id, handoff.identity_id, handoff.email,
      handoff.workspace_id, handoff.operation_id, this.config.machineId, handoff.session_id, sessionId, hashToken(secret)]);
    if (handoff.invitationIds?.length) await this.enrollment.rpc({}, 'accept_control_space_invitations', [handoff.account_id, handoff.email, handoff.invitationIds]);
    return { token: formatToken(sessionId, secret), expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(), workspaceId: handoff.workspace_id };
  }
  async authorize(identity: RequestIdentity): Promise<void> {
    if (!identity.identityId || !identity.sessionId) throw new CollabError('unauthenticated', 'Central sign-in required');
    const rows = await this.db.query<LeaseLink>({ identityId: identity.identityId, authKind: identity.authKind },
      'select central_session_id,workspace_id,lease_until from public.control_session_links where session_id=$1', [identity.sessionId]);
    const link = rows[0];
    if (!link) throw new CollabError('unauthenticated', 'Use central sign-in to access this node');
    const expires = new Date(link.lease_until).getTime();
    if (expires - Date.now() > 5000) return;
    try {
      const lease = await this.call<{ workspace_id: string; account_id: string; identity_id: string }>('/node/lease', { sessionId: link.central_session_id });
      if (lease.workspace_id !== link.workspace_id || lease.account_id !== identity.accountId || lease.identity_id !== identity.identityId) throw new CollabError('unauthenticated', 'Central identity mismatch');
      await this.enrollment.rpc({}, 'refresh_control_lease', [identity.sessionId, link.central_session_id, link.workspace_id]);
    } catch (error) {
      // An outage may use only the remainder of the already granted lease.
      if (error instanceof CollabError && error.code === 'upstream_unavailable' && Date.now() < expires) return;
      throw error;
    }
  }
  async status(workspaceId: string, state: 'provisioning' | 'ready' | 'failed'): Promise<void> {
    await this.call('/node/workspace-status', { workspaceId, state });
  }
  async revoke(identity: RequestIdentity, sessionId: string): Promise<void> {
    const rows = await this.db.query<LeaseLink>({ identityId: identity.identityId, authKind: identity.authKind },
      'select central_session_id,workspace_id,lease_until from public.control_session_links where session_id=$1', [sessionId]);
    if (!rows[0]) throw new CollabError('forbidden', 'Session does not belong to your workspace');
    await this.call('/node/logout', { sessionId: rows[0].central_session_id });
  }
  async invite(identity: RequestIdentity, invitation: { id: string; space_id: string; email: string; expires_at: string }): Promise<unknown> {
    const rows = await this.db.query<LeaseLink>({ identityId: identity.identityId, authKind: identity.authKind },
      'select central_session_id,workspace_id,lease_until from public.control_session_links where session_id=$1', [identity.sessionId]);
    if (!rows[0]) throw new CollabError('unauthenticated', 'Central sign-in required');
    const code = createHmac('sha256', this.config.machineCredential!).update(`tm8-space-invitation:${invitation.id}`).digest('base64url');
    await this.call('/node/invitations', { sessionId: rows[0].central_session_id, invitationId: invitation.id,
      spaceId: invitation.space_id, email: invitation.email, expiresAt: invitation.expires_at, code });
    return { id: invitation.id, url: `${this.config.controlOrigin}/#invite=${encodeURIComponent(code)}`, expiresAt: invitation.expires_at };
  }
  async revokeInvitation(invitationId: string): Promise<void> { await this.call('/node/invitations/revoke', { invitationId }); }
  async close(): Promise<void> { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); await this.enrollment.end(); }
}
