import {
  CollabError,
  type ServerConnection,
  type ServerConnectionCreateInput,
} from '@tm8/contract';

import type { RequestContext } from '../../../http/types.js';
import { claimsFor, commandEnvelope, requireParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';

interface ServerConnectionRow {
  id: string;
  name: string;
  base_url: string;
  username: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ServerConnectionMutationResult {
  connection: ServerConnection;
}

const SELECT = `
  select id, name, base_url, username, created_at, updated_at
    from public.server_connections`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toServerConnection(row: ServerConnectionRow): ServerConnection {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    username: row.username,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function normalizeMutationConnection(connection: ServerConnection): ServerConnection {
  return {
    ...connection,
    createdAt: iso(connection.createdAt),
    updatedAt: iso(connection.updatedAt),
  };
}

export class W2ServerConnectionsService {
  constructor(private readonly deps: FacadeDeps) {}

  readonly list = async (ctx: RequestContext): Promise<ServerConnection[]> => {
    const owner = await this.deps.owner();
    const rows = await this.deps.db.query<ServerConnectionRow>(
      claimsFor(owner, ctx),
      `${SELECT} order by name asc`,
    );
    return rows.map(toServerConnection);
  };

  readonly get = async (ctx: RequestContext): Promise<ServerConnection> => {
    const owner = await this.deps.owner();
    const name = requireParam(ctx, 'name').toLowerCase();
    const rows = await this.deps.db.query<ServerConnectionRow>(
      claimsFor(owner, ctx),
      `${SELECT} where name = $1`,
      [name],
    );
    const row = rows[0];
    if (!row) throw new CollabError('not_found', `no such server connection: ${name}`);
    return toServerConnection(row);
  };

  readonly create = async (ctx: RequestContext): Promise<ServerConnection> => {
    const owner = await this.deps.owner();
    const input = ctx.body as ServerConnectionCreateInput;
    const envelope = commandEnvelope(ctx);
    const result = await this.deps.db.rpc<ServerConnectionMutationResult>(
      claimsFor(owner, ctx, envelope),
      'create_server_connection',
      [input.name, input.baseUrl, input.username ?? null, input.clientMutationId],
    );
    return normalizeMutationConnection(result.connection);
  };

  readonly delete = async (ctx: RequestContext): Promise<ServerConnection> => {
    const owner = await this.deps.owner();
    const name = requireParam(ctx, 'name').toLowerCase();
    const envelope = commandEnvelope(ctx);
    const result = await this.deps.db.rpc<ServerConnectionMutationResult>(
      claimsFor(owner, ctx, envelope),
      'delete_server_connection',
      [name, envelope.clientMutationId ?? null],
    );
    return normalizeMutationConnection(result.connection);
  };
}
