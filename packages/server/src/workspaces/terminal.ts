import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { RequestIdentity } from '../http/types.js';
import type { UpgradeTarget } from '../http/server.js';
import type { WorkspaceService } from './service.js';
import { PTY_WS_PROTOCOL } from '@tm8/contract';
import { createPtyAttachAuthorizer } from '../pty/attach-authz.js';

export const isWorkspaceTerminal = (req: IncomingMessage): boolean => /^\/v2\/workspaces\/terminals\/[0-9a-f-]+\/ws(?:\?|$)/i.test(req.url ?? '');
export function createWorkspaceTerminal(service: WorkspaceService, resolveIdentity: (req: IncomingMessage) => Promise<RequestIdentity>): UpgradeTarget {
  const server = new WebSocketServer({ noServer: true, maxPayload: 65536,
    handleProtocols: offered => offered.has(PTY_WS_PROTOCOL) ? PTY_WS_PROTOCOL : false });
  const attach = createPtyAttachAuthorizer({ db: service.deps?.db,
    resolveIdentityId: async req => (await resolveIdentity(req)).identityId });
  return {
    async handleUpgrade(req, socket, head) {
      try {
        const match = /^\/v2\/workspaces\/terminals\/([0-9a-f-]+)\/ws$/.exec(new URL(req.url!, 'http://node').pathname);
        if (!match) throw new Error('Invalid terminal path');
        const identity = await resolveIdentity(req);
        const workspace = await service.workspaceForIdentity(identity);
        const info = await service.broker.request<{ projectId: string | null; credentialProvider?: string | null; execution?: boolean }>('/terminal/info', { sessionId: match[1], workspaceId: workspace.id, accountId: workspace.account_id });
        let canDrive = true;
        if (info.execution) {
          if (!['browser', 'cli'].includes(identity.authKind ?? '')) throw new Error('Human session required');
          const verdict = await attach(req, match[1]!);
          if (!verdict.ok || verdict.subjectIdentity !== identity.identityId) throw new Error('Attach refused');
          canDrive = verdict.canDrive;
        }
        const authorize = async () => {
          const current = await resolveIdentity(req);
          if (current.accountId !== identity.accountId) throw new Error('Identity changed');
          if (info.credentialProvider && !['browser', 'cli'].includes(current.authKind ?? '')) throw new Error('Only human sessions may access provider login terminals');
          if (info.execution) {
            if (!['browser', 'cli'].includes(current.authKind ?? '')) throw new Error('Human session required');
            const rows = await service.deps.db.query<{ allowed: boolean }>({ identityId: current.identityId, authKind: current.authKind },
              `select (not $3::boolean or internal.can_act_as(e.created_by,e.space_id)) as allowed
               from public.entities e join public.work_sessions w on w.entity_id=e.id
               where e.id=$1 and e.deleted_at is null and w.node_id=$2`, [match[1], `workspace:${workspace.id}`, canDrive]);
            if (!rows[0]?.allowed) throw new Error('Session access revoked');
          }
          await service.workspaceForIdentity(current);
          if (info.projectId) {
            const rows = await service.deps.db.query<{ project_id: string }>({ identityId: current.identityId, authKind: current.authKind },
              'select project_id from public.workspace_repositories where project_id=$1', [info.projectId]);
            if (!rows[0]) throw new Error('Project membership revoked');
          }
        };
        await authorize();
        const query = new URLSearchParams({ workspaceId: workspace.id, accountId: workspace.account_id });
        if (info.execution) query.set('offset', new URL(req.url!, 'http://node').searchParams.get('offset') ?? '0');
        const upstream = new WebSocket(`ws+unix://${service.broker.socketPath}:/terminal/${match[1]}?${query}`, { handshakeTimeout: 5000, maxPayload: 1024 * 1024 });
        const initial: Array<{ data: RawData; binary: boolean }> = [];
        let initialBytes = 0;
        const bufferInitial = (data: RawData, binary: boolean) => {
          initialBytes += Array.isArray(data) ? data.reduce((sum, value) => sum + value.length, 0) : data.byteLength;
          if (initialBytes > 1024 * 1024) upstream.close(1013);
          else initial.push({ data, binary });
        };
        upstream.on('message', bufferInitial);
        await new Promise<void>((resolve, reject) => { upstream.once('open', resolve); upstream.once('error', reject); });
        server.handleUpgrade(req, socket, head, client => {
          let checking = false;
          const timer = setInterval(() => {
            if (checking) return;
            checking = true;
            void authorize().catch(() => client.close(1008, 'Authorization expired')).finally(() => { checking = false; });
          }, 1000);
          timer.unref();
          let sequence = Promise.resolve(), queued = 0;
          client.on('message', (data, binary) => {
            const size = Array.isArray(data) ? data.reduce((sum, value) => sum + value.length, 0) : data.byteLength;
            queued += size;
            if (queued > 1024 * 1024) { client.close(1013); return; }
            sequence = sequence.then(async () => { await authorize(); if (canDrive && upstream.readyState === WebSocket.OPEN && client.readyState === WebSocket.OPEN) upstream.send(data, { binary }); }).catch(() => client.close(1008, 'Authorization expired')).finally(() => { queued -= size; });
          });
          upstream.off('message', bufferInitial);
          upstream.on('message', (data, binary) => { if (client.bufferedAmount > 1024 * 1024) client.close(1013); else if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
          for (const frame of initial) client.send(frame.data, { binary: frame.binary });
          if (upstream.readyState === WebSocket.CLOSED) client.close(1000);
          const close = () => { clearInterval(timer); upstream.close(); client.close(); };
          client.on('close', close); client.on('error', close); upstream.on('close', close); upstream.on('error', close);
        });
      } catch { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); }
    },
    closeAll() { for (const client of server.clients) client.close(1001); server.close(); },
  };
}
